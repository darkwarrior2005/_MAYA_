import { simpleGit } from "simple-git";
import type { AgentDescriptor, TaskSpec } from "@maya/shared-types";
import type { AgentAdapter } from "../adapters/adapter.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import { withRunLimits } from "../adapters/watchdog.js";
import type { EventBus } from "../bus/event-bus.js";
import type { WorkerProfile } from "../config/maya-config.js";
import { BranchManager } from "../git/branch-manager.js";
import { MergeService } from "../git/merge-service.js";
import type { RepoManager } from "../git/repo-manager.js";
import { WorktreeManager } from "../git/worktree-manager.js";
import { ContextWriter } from "../persistence/context-writer.js";
import type { ConflictResolver } from "./conflict-resolver.js";
import { publishAgentEvent } from "./secret-channel.js";
import { Planner, describePlan, type Plan } from "./planner.js";
import { SummaryGenerator } from "./summary-generator.js";
import type { TaskQueue } from "./task-queue.js";
import { withSecretChannel } from "./task-runner.js";

export interface OperatorDeps {
  repo: RepoManager;
  registry: AdapterRegistry;
  bus: EventBus;
  queue: TaskQueue;
  conflicts: ConflictResolver;
  workers: WorkerProfile[];
  /**
   * The Operator's own profile. Given one, it describes each worker's change
   * for the commit message instead of restating the task; without one, the
   * behaviour is unchanged.
   */
  operator?: WorkerProfile;
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
  private readonly summaries: SummaryGenerator;
  private readonly planner: Planner;

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
    const operator = deps.operator;
    const thinking =
      operator && deps.registry.has(operator.tool)
        ? { adapter: deps.registry.get(operator.tool), profile: operator }
        : undefined;
    this.summaries = new SummaryGenerator(thinking);
    this.planner = new Planner(thinking);
  }

  /**
   * Splits one request into tasks, puts the split to the person, then runs
   * whatever they settled on.
   *
   * The confirmation is not ceremony. A plan decides how many agent runs
   * happen and what each one is told, and a bad split costs money and leaves
   * branches that conflict. It goes out as the same question type the
   * Operator already uses for a blocked merge, so it renders in the panes and
   * in the browser with no new machinery.
   */
  async planAndRun(request: string): Promise<OperatorRunReport> {
    const plan = await this.planner.plan(request);
    return this.run(await this.confirm(request, plan));
  }

  private async confirm(request: string, plan: Plan): Promise<string[]> {
    // Nothing was planned, so there is nothing to agree to.
    if (!plan.generated) return plan.tasks;

    const answer = await this.deps.conflicts.resolve({
      question: describePlan(request, plan),
      options: [
        {
          id: "accept",
          label: `Run ${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"} as planned`,
        },
        { id: "single", label: "Run the whole request as one task instead" },
      ],
      allowCustom: true,
    });

    if (answer.custom) {
      // Their own words replace the request entirely, as one task. Re-planning
      // from them would put another question in front of someone who has just
      // told Maya what they want.
      return [answer.chosen];
    }
    return answer.chosen === "single" ? [request] : plan.tasks;
  }

  async run(instructions: string[]): Promise<OperatorRunReport> {
    const base = await this.branches.baseBranch();
    const tasks = instructions.map((instruction) =>
      this.deps.queue.add(firstLine(instruction), instruction),
    );

    const outcomes = await this.dispatchAll(tasks, base);

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

  /**
   * Workers run in parallel; each worker runs its own tasks one at a time.
   *
   * Handing every task out at once meant a worker with more tasks than
   * colleagues ran them simultaneously — observed with one worker and three
   * tasks, all three started before any finished. They then share one raw log
   * file, one pane and one `latest.md` snapshot, so two of the three
   * snapshots are overwritten and the log of all three is interleaved.
   *
   * Outcomes come back in the order the tasks were given, not the order they
   * happened to finish, so the merge order is the order the user asked for.
   */
  private async dispatchAll(tasks: TaskSpec[], base: string): Promise<WorkerOutcome[]> {
    const lanes = new Map<number, Array<{ position: number; task: TaskSpec }>>();
    tasks.forEach((task, position) => {
      const lane = position % this.deps.workers.length;
      const queue = lanes.get(lane) ?? [];
      queue.push({ position, task });
      lanes.set(lane, queue);
    });

    const done: Array<{ position: number; outcome: WorkerOutcome }> = [];
    await Promise.all(
      [...lanes.entries()].map(async ([lane, queued]) => {
        const worker = this.workerFor(lane);
        for (const { position, task } of queued) {
          done.push({ position, outcome: await this.dispatch(task, worker, base) });
        }
      }),
    );

    return done.sort((a, b) => a.position - b.position).map((entry) => entry.outcome);
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

    const handle = withRunLimits(
      await adapter.start({
        agentId: profile.id,
        cwd: worktree.path,
        prompt: withSecretChannel(task.instruction),
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.allowedTools ? { allowedTools: profile.allowedTools } : {}),
        ...(profile.deniedTools ? { deniedTools: profile.deniedTools } : {}),
        ...(profile.maxTurns !== undefined ? { maxTurns: profile.maxTurns } : {}),
        ...(profile.maxBudgetUsd !== undefined ? { maxBudgetUsd: profile.maxBudgetUsd } : {}),
      }),
      {
        stallTimeoutSec: profile.stallTimeoutSec,
        ...(profile.maxRunSeconds !== undefined ? { maxRunSeconds: profile.maxRunSeconds } : {}),
        ...(profile.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {}),
      },
    );

    handle.onEvent((event) => {
      // The transcript comes back from the publisher, which has already taken
      // the user's private lines out of it.
      const recorded = publishAgentEvent(this.deps.bus, profile.id, event);
      if (recorded.transcript) transcript.push(recorded.transcript);
    });

    const result = await handle.waitForCompletion();

    this.contextWriter.write({
      agent,
      taskSummary: `${task.summary}\n\nbranch: ${worktree.branch}\nworktree: ${worktree.path}`,
      transcript: transcript.join("\n"),
      status: result.stalled ? "stalled" : result.ok ? "completed" : "failed",
    });

    // Commit inside the worktree, where the agent actually wrote files. The
    // message describes the change rather than restating the request — see
    // SummaryGenerator for why that was worth building.
    let committed: string | null = null;
    let summary = task.summary;
    if (result.ok) {
      // Staged first, then described, then committed: the branch holds
      // nothing until the commit, so the staged diff is the only place the
      // change can be read from.
      const branchManager = new BranchManager(simpleGit(worktree.path));
      if (await branchManager.stageAll()) {
        const described = await this.summaries.describe({
          instruction: task.instruction,
          transcript: transcript.join("\n"),
          diff: await branchManager.stagedDiffStat(),
        });
        summary = described.subject;
        committed = await branchManager.commitStaged(
          commitMessage(described.subject, described.body, task.id, agent.displayName),
        );
      }
    }

    this.deps.bus.publish("main", profile.id, "task_completed", {
      type: "task_completed",
      taskId: task.id,
      agentId: profile.id,
      ok: result.ok,
      summary,
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

/** Subject, blank line, body, then the trailer — git's own shape. */
function commitMessage(subject: string, body: string, taskId: string, agent: string): string {
  const trailer = `Task ${taskId} by ${agent}`;
  const parts = body ? [subject, "", body, "", trailer] : [subject, "", trailer];
  return parts.join("\n");
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "task";
  return line.length > 72 ? `${line.slice(0, 69)}...` : line;
}
