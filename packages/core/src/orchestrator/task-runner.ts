import { randomUUID } from "node:crypto";
import type { AgentDescriptor, AgentEvent, TaskId } from "@maya/shared-types";
import type { AgentAdapter } from "../adapters/adapter.js";
import { withRunLimits } from "../adapters/watchdog.js";
import type { EventBus } from "../bus/event-bus.js";
import { BranchManager } from "../git/branch-manager.js";
import { MergeService } from "../git/merge-service.js";
import type { RepoManager } from "../git/repo-manager.js";
import { ContextWriter } from "../persistence/context-writer.js";
import {
  OPERATOR_CHANNEL_BRIEFING,
  SECRET_CHANNEL_BRIEFING,
  publishAgentEvent,
} from "./secret-channel.js";
import type { AnsweredQuestion } from "./question-answerer.js";

export interface TaskRunInput {
  instruction: string;
  summary?: string;
  agent: AgentDescriptor;
  stallTimeoutSec?: number;
  maxRunSeconds?: number;
  maxTokens?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowedTools?: string[];
  deniedTools?: string[];
  /** Skip the merge step and leave the work on its branch for review. */
  holdForReview?: boolean;
}

export interface TaskRunOutcome {
  taskId: TaskId;
  branch: string;
  committed: string | null;
  merged: boolean;
  conflicts: string[];
  stalled: boolean;
  ok: boolean;
  error?: string;
}

/**
 * The Phase 1 chain end to end: branch, run one agent, capture context, commit,
 * merge. The Operator (Phase 2) drives many of these in parallel; the sequence
 * inside a single task is identical either way.
 */
export class TaskRunner {
  private readonly branches: BranchManager;
  private readonly merges: MergeService;
  private readonly contextWriter: ContextWriter;

  constructor(
    private readonly repo: RepoManager,
    private readonly adapter: AgentAdapter,
    private readonly bus: EventBus,
  ) {
    this.branches = new BranchManager(repo.git);
    this.merges = new MergeService(repo.git);
    this.contextWriter = new ContextWriter(repo.paths, (warning) => {
      this.bus.publish("system", null, "error", {
        type: "error",
        agentId: "maya",
        message: warning,
        fatal: false,
      } as AgentEvent);
    });
  }

  async run(input: TaskRunInput): Promise<TaskRunOutcome> {
    const taskId = randomUUID().slice(0, 8);
    const summary = input.summary ?? firstLine(input.instruction);
    const base = await this.branches.baseBranch();
    const branch = await this.branches.createTaskBranch(taskId, input.agent.id);

    this.bus.publish("main", input.agent.id, "task_assigned", {
      type: "task_assigned",
      taskId,
      agentId: input.agent.id,
      branch,
      summary,
    });

    const transcript: string[] = [];
    const handle = withRunLimits(
      await this.adapter.start({
        agentId: input.agent.id,
        cwd: this.repo.repoRoot,
        prompt: withAgentChannels(input.instruction),
        ...(input.agent.model ? { model: input.agent.model } : {}),
        ...(input.allowedTools ? { allowedTools: input.allowedTools } : {}),
        ...(input.deniedTools ? { deniedTools: input.deniedTools } : {}),
        ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
        ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
      }),
      {
        ...(input.stallTimeoutSec !== undefined
          ? { stallTimeoutSec: input.stallTimeoutSec }
          : {}),
        ...(input.maxRunSeconds !== undefined ? { maxRunSeconds: input.maxRunSeconds } : {}),
        ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      },
    );

    const asked: Array<{ questionId: string; question: string }> = [];
    handle.onEvent((event) => {
      // The transcript comes back from the publisher, which has already taken
      // the user's private lines out of it.
      const recorded = publishAgentEvent(this.bus, input.agent.id, event);
      if (recorded.transcript) transcript.push(recorded.transcript);
      asked.push(...recorded.questions);
    });

    const result = await handle.waitForCompletion();

    // `maya run` is one agent and no Operator, so there is nobody to answer.
    // Say that in the log rather than leaving the question unanswered on
    // screen: the worker was told the Operator would reply, and a promise the
    // log does not keep is worse than a plain "no Operator here".
    for (const question of asked) {
      this.bus.publish("main", input.agent.id, "operator_answer", {
        type: "operator_answer",
        questionId: question.questionId,
        agentId: input.agent.id,
        answer: NO_OPERATOR,
        answered: false,
      });
    }

    this.contextWriter.write({
      agent: input.agent,
      taskSummary: `${summary}\n\nbranch: ${branch}`,
      transcript: transcript.join("\n"),
      status: result.stalled ? "stalled" : result.ok ? "completed" : "failed",
    });

    const committed = await this.branches.commitAll(
      `${summary}\n\nTask ${taskId} by ${input.agent.displayName}`,
    );

    // A stalled or failed agent never gets its work merged.
    if (!result.ok || input.holdForReview) {
      await this.branches.checkout(base);
      this.bus.publish("main", input.agent.id, "task_completed", {
        type: "task_completed",
        taskId,
        agentId: input.agent.id,
        ok: result.ok,
        summary: result.stalled ? `${summary} (stalled)` : summary,
      });
      return {
        taskId,
        branch,
        committed,
        merged: false,
        conflicts: [],
        stalled: result.stalled,
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
      };
    }

    const merge = await this.merges.mergeTaskBranch(branch, base);
    this.bus.publish("main", input.agent.id, "merge_result", {
      type: "merge_result",
      taskId,
      branch,
      merged: merge.merged,
      conflicts: merge.conflicts,
    });
    this.bus.publish("main", input.agent.id, "task_completed", {
      type: "task_completed",
      taskId,
      agentId: input.agent.id,
      ok: merge.merged,
      summary,
    });

    return {
      taskId,
      branch,
      committed,
      merged: merge.merged,
      conflicts: merge.conflicts,
      stalled: false,
      ok: merge.merged,
      ...(merge.message && !merge.merged ? { error: merge.message } : {}),
    };
  }
}

/**
 * Agents cannot use a channel they were never told about, so both briefings
 * ride along with every instruction.
 *
 * The Operator one comes second deliberately: read in order, it says "reach
 * the human for what only they can decide, and the Operator for everything
 * else", which is the behaviour wanted. A worker briefed only on `@user`
 * interrupts the person over things the Operator could have settled.
 */
export function withAgentChannels(instruction: string): string {
  return `${instruction}

---
${SECRET_CHANNEL_BRIEFING}

${OPERATOR_CHANNEL_BRIEFING}`;
}

/** Kept under the old name: adapter plugins and tests import it. */
export const withSecretChannel = withAgentChannels;

export const NO_OPERATOR =
  "No Operator is running this task (`maya run` drives one agent on its own), so this question went unanswered. Use `maya start` for a session with an Operator.";

/** How the Operator's answers are handed back to the worker that asked. */
export function describeAnswers(answers: AnsweredQuestion[]): string {
  const lines = ["The Operator answered what you asked:", ""];
  for (const answer of answers) {
    lines.push(`You asked: ${answer.question}`);
    lines.push(`Operator: ${answer.answer}`);
    lines.push("");
  }
  lines.push(
    "Carry on with the task from here. If an answer changes what you have",
    "already done, fix it; say in your summary what you changed and why.",
  );
  return lines.join("\n");
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "task";
  return line.length > 72 ? `${line.slice(0, 69)}...` : line;
}
