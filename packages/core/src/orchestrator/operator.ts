import { simpleGit } from "simple-git";
import type { AgentDescriptor, TaskSpec } from "@maya/shared-types";
import type { AgentAdapter, AgentRunResult } from "../adapters/adapter.js";
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
import { QuestionAnswerer, type AnsweredQuestion } from "./question-answerer.js";
import { SummaryGenerator } from "./summary-generator.js";
import type { TaskQueue } from "./task-queue.js";
import { describeAnswers, withAgentChannels } from "./task-runner.js";

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
  private readonly answerer: QuestionAnswerer;

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
    this.answerer = new QuestionAnswerer(thinking);
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

  /**
   * Has the Operator answer what a worker asked, and puts both in the log.
   *
   * The answer is published whether or not the worker can be resumed to hear
   * it: the question is in the chat either way, and a question with no
   * visible answer looks like Maya swallowed it. Where no Operator is
   * configured the answer says so plainly rather than inventing a ruling.
   */
  private async answerQuestions(
    asked: Array<{ questionId: string; question: string }>,
    task: TaskSpec,
    profile: WorkerProfile,
  ): Promise<AnsweredQuestion[]> {
    const siblings = this.deps.queue
      .all()
      .filter((other) => other.id !== task.id)
      .map((other) => other.instruction);

    const answers = await this.answerer.answer(asked, {
      instruction: task.instruction,
      askedBy: profile.displayName,
      ...(siblings.length > 0 ? { siblingTasks: siblings } : {}),
    });

    for (const answer of answers) {
      this.deps.bus.publish("main", profile.id, "operator_answer", {
        type: "operator_answer",
        questionId: answer.questionId,
        agentId: profile.id,
        answer: answer.answer,
        answered: answer.answered,
      });
    }
    return answers;
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
    // One shared queue that each worker pulls from when it is free, rather
    // than dealing the tasks out in advance. Pre-assigning round-robin meant a
    // worker handed a long task sat on everything behind it while another
    // worker finished early and idled — with three tasks and two workers, the
    // third waited for the first to finish even if the second took seconds.
    const pending = tasks.map((task, position) => ({ position, task }));
    const done: Array<{ position: number; outcome: WorkerOutcome }> = [];

    await Promise.all(
      this.deps.workers.map(async (worker) => {
        for (;;) {
          const next = pending.shift();
          if (!next) return;
          done.push({ position: next.position, outcome: await this.dispatch(next.task, worker, base) });
        }
      }),
    );

    // In the order the tasks were given, not the order they happened to
    // finish, so the merge order is the one the person asked for.
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
    let asked: Array<{ questionId: string; question: string }> = [];

    const runAgent = async (prompt: string, resumeSessionId?: string): Promise<AgentRunResult> => {
      const handle = withRunLimits(
        await adapter.start({
          agentId: profile.id,
          cwd: worktree.path,
          prompt,
          ...(resumeSessionId ? { resumeSessionId } : {}),
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
        // the user's private lines out of it, and tells us what the worker
        // asked the Operator.
        const recorded = publishAgentEvent(this.deps.bus, profile.id, event);
        if (recorded.transcript) transcript.push(recorded.transcript);
        asked.push(...recorded.questions);
      });

      return handle.waitForCompletion();
    };

    let result = await runAgent(withAgentChannels(task.instruction));

    // A worker that asked the Operator something gets an answer back, and one
    // more turn to act on it.
    //
    // It has to be a second turn: a wrapped CLI is a one-shot subprocess with
    // no way to take input mid-run, so there is nowhere to deliver an answer
    // while it is still working. Resuming its session is what makes this a
    // conversation rather than a question shouted into the log — and only for
    // an adapter that can resume, which is why `resumable` is probed.
    if (asked.length > 0) {
      const answers = await this.answerQuestions(asked, task, profile);
      // Only pay for a second turn when there is something to deliver. With
      // no Operator configured every answer is "nobody could answer", and
      // resuming to say so costs a run and tells the worker nothing it could
      // not have assumed. The answer is in the log for the person either way.
      const worthResuming = answers.some((answer) => answer.answered);
      const resumable = adapter.capabilities.resumable && result.sessionId;
      if (worthResuming && resumable && result.ok) {
        // Cleared first: a resumed worker may ask again, and a loop of
        // question-and-resume would spend without a bound. One round.
        asked = [];
        result = await runAgent(describeAnswers(answers), result.sessionId);
      }
    }

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
          diff: await branchManager.stagedDiffStat(base),
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
