import { simpleGit } from "simple-git";
import type { AgentDescriptor, TaskSpec } from "@maya/shared-types";
import type { AgentAdapter } from "../adapters/adapter.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import { withStallWatchdog } from "../adapters/watchdog.js";
import type { EventBus } from "../bus/event-bus.js";
import type { WorkerProfile } from "../config/maya-config.js";
import { BranchManager } from "../git/branch-manager.js";
import { MergeService } from "../git/merge-service.js";
import type { RepoManager } from "../git/repo-manager.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import { ContextWriter } from "../persistence/context-writer.js";
import type { ConflictResolver } from "./conflict-resolver.js";
import type { TaskQueue } from "./task-queue.js";

export interface OperatorDeps {
  repo: RepoManager;
  registry: AdapterRegistry;
  bus: EventBus;
  queue: TaskQueue;
  conflicts: ConflictResolver;
  workers: WorkerProfile[];
}

export interface WorkerOutcome {
  task: TaskSpec;
  agent: AgentDescriptor;
  branch: string;
  ok: boolean;
  stalled: boolean;
  committed: string | null;
  transcript: string;
  error?: string;
}

export interface OperatorRunReport {
  outcomes: WorkerOutcome[];
  merged: string[];
  held: string[];
}

/**
 * Assigns work, then has the only say over what lands. Workers run in parallel,
 * each in its own worktree; merging is deliberately sequential so two clean
 * branches cannot race into a broken main.
 */
export class Operator {
  private readonly worktrees: WorktreeManager;
  private readonly branches: BranchManager;
  private readonly merges: MergeService;
  private readonly contextWriter: ContextWriter;

  constructor(private readonly deps: OperatorDeps) {
    this.worktrees = new WorktreeManager(deps.repo.git, deps.repo.paths);
    this.branches = new BranchManager(deps.repo.git);
    this.merges = new MergeService(deps.repo.git);
    this.contextWriter = new ContextWriter(deps.repo.paths, (warning) =>
      this.deps.bus.publish("system", null, "error", {
        type: "error",
        agentId: "maya",
        message: warning,
        fatal: false,
      }),
    );
  }

  async run(instructions: string[]): Promise<OperatorRunReport> {
    const base = await this.branches.baseBranch();
    const tasks = instructions.map((instruction) =>
      this.deps.queue.add(firstLine(instruction), instruction),
    );

    const outcomes = await Promise.all(
      tasks.map((task, index) => this.dispatch(task, this.workerFor(index), base)),
    );

    const merged: string[] = [];
    const held: string[] = [];

    // Sequential on purpose: each merge must see the result of the last one.
    for (const outcome of outcomes) {
      if (!outcome.ok || !outcome.committed) {
        held.push(outcome.branch);
        this.deps.queue.setState(outcome.task.id, outcome.stalled ? "failed" : "blocked");
        continue;
      }

      const result = await this.merges.mergeTaskBranch(outcome.branch, base);
      this.deps.bus.publish("main", outcome.agent.id, "merge_result", {
        type: "merge_result",
        taskId: outcome.task.id,
        branch: outcome.branch,
        merged: result.merged,
        conflicts: result.conflicts,
      });

      if (result.merged) {
        merged.push(outcome.branch);
        this.deps.queue.setState(outcome.task.id, "merged");
        continue;
      }

      // A blocked merge is the user's call, never the Operator's to force.
      const answer = await this.deps.conflicts.resolve({
        question: `"${outcome.task.summary}" conflicts with ${base} in ${
          result.conflicts.join(", ") || "the working tree"
        }. How should this be handled?`,
        options: [
          { id: "hold", label: `Keep the work on ${outcome.branch} for manual review` },
          { id: "discard", label: "Abandon this branch", proposedBy: outcome.agent.id },
        ],
      });

      held.push(outcome.branch);
      this.deps.queue.setState(outcome.task.id, answer.chosen === "discard" ? "failed" : "blocked");
    }

    return { outcomes, merged, held };
  }

  private workerFor(index: number): WorkerProfile {
    const workers = this.deps.workers;
    if (workers.length === 0) throw new Error("no workers configured");
    return workers[index % workers.length] as WorkerProfile;
  }

  private async dispatch(
    task: TaskSpec,
    profile: WorkerProfile,
    base: string,
  ): Promise<WorkerOutcome> {
    const agent: AgentDescriptor = {
      id: profile.id,
      role: "worker",
      tool: profile.tool,
      displayName: profile.displayName,
      ...(profile.model ? { model: profile.model } : {}),
    };

    const worktree = await this.worktrees.create(task.id, profile.id, base);
    this.deps.queue.assign(task.id, profile.id, worktree.branch);
    this.deps.bus.publish("main", profile.id, "task_assigned", {
      type: "task_assigned",
      taskId: task.id,
      agentId: profile.id,
      branch: worktree.branch,
      summary: task.summary,
    });
    this.deps.queue.setState(task.id, "running");

    const adapter: AgentAdapter = this.deps.registry.get(profile.tool);
    const transcript: string[] = [];

    const handle = withStallWatchdog(
      await adapter.start({
        agentId: profile.id,
        cwd: worktree.path,
        prompt: task.instruction,
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.allowedTools ? { allowedTools: profile.allowedTools } : {}),
        ...(profile.deniedTools ? { deniedTools: profile.deniedTools } : {}),
      }),
      profile.stallTimeoutSec,
    );

    handle.onEvent((event) => {
      if (event.type === "text") transcript.push(event.text);
      if (event.type === "tool_call") transcript.push(`[tool] ${event.toolName}`);
      this.deps.bus.publish("main", profile.id, event.type, event);
    });

    const result = await handle.waitForCompletion();

    this.contextWriter.write({
      agent,
      taskSummary: `${task.summary}\n\nbranch: ${worktree.branch}\nworktree: ${worktree.path}`,
      transcript: transcript.join("\n"),
      status: result.stalled ? "stalled" : result.ok ? "completed" : "failed",
    });

    // Commit inside the worktree, where the agent actually wrote files.
    const committed = result.ok
      ? await new BranchManager(simpleGit(worktree.path)).commitAll(
          `${task.summary}\n\nTask ${task.id} by ${agent.displayName}`,
        )
      : null;

    this.deps.bus.publish("main", profile.id, "task_completed", {
      type: "task_completed",
      taskId: task.id,
      agentId: profile.id,
      ok: result.ok,
      summary: task.summary,
    });

    // The branch now holds the commit; the checkout itself is disposable.
    await this.worktrees.remove(worktree.path);

    return {
      task,
      agent,
      branch: worktree.branch,
      ok: result.ok,
      stalled: result.stalled,
      committed,
      transcript: transcript.join("\n"),
      ...(result.error ? { error: result.error } : {}),
    };
  }
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "task";
  return line.length > 72 ? `${line.slice(0, 69)}...` : line;
}
