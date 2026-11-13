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
  /**
   * Present when the run reported success, committed nothing and said nothing
   * to anybody, so a caller can show why rather than printing a bare
   * "finished ok" over an empty commit. Its presence is the signal;
   * `lastWords` is absent when the worker said nothing at all.
   */
  stoppedShort?: { lastWords?: string };
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
    let reachedUser = false;
    handle.onEvent((event) => {
      // The transcript comes back from the publisher, which has already taken
      // the user's private lines out of it.
      const recorded = publishAgentEvent(this.bus, input.agent.id, event);
      if (recorded.transcript) transcript.push(recorded.transcript);
      asked.push(...recorded.questions);
      if (recorded.reachedUser) reachedUser = true;
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

    // Reported success, changed nothing, told nobody. The Operator already
    // holds such a branch and marks the task blocked, so the state machine
    // was never wrong — what was missing is anyone being told *why*, and the
    // reason is usually a question the worker asked in prose where nothing is
    // listening. This goes on the secret channel because that panel exists to
    // put things the person must see in front of them, and being asked
    // nothing is exactly how this failure feels from the other side.
    //
    // The quote is not what decides this. It used to be — `stoppedShort` was
    // the worker's closing words or null — so a worker that stopped having
    // said nothing produced no report at all, which is the quietest form of
    // the very failure this catches. Antigravity does exactly that when every
    // tool it tried was denied: tool calls, no text.
    const stoppedShort = result.ok && !committed && asked.length === 0 && !reachedUser;
    const closing = stoppedShort ? lastWords(transcript) : null;
    if (stoppedShort) {
      this.bus.publish("secret", input.agent.id, "worker_stopped_short", {
        type: "worker_stopped_short",
        taskId,
        agentId: input.agent.id,
        ...(closing ? { lastWords: closing } : {}),
      });
    }

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
        ...(stoppedShort ? { stoppedShort: { ...(closing ? { lastWords: closing } : {}) } } : {}),
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
      ...(stoppedShort ? { stoppedShort: { ...(closing ? { lastWords: closing } : {}) } } : {}),
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

/** How much of a worker's closing text to quote back to the person. */
const LAST_WORDS_LIMIT = 600;

/**
 * The worker's closing text, for quoting when it stopped without doing the
 * work.
 *
 * The last text event rather than the whole transcript: by then the agent is
 * explaining itself, which is the part worth reading. The full thing stays in
 * the main transcript and the context snapshot, so this is a pointer, not a
 * record — hence the cap, and hence keeping the *start* of it: an agent that
 * is asking tends to lead with the question (Codex did) while an agent that
 * is explaining leads with the reason, and both are near the front.
 */
export function lastWords(transcript: string[]): string | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index]?.trim();
    // Tool lines are the publisher's own annotations, not the agent talking.
    if (!entry || entry.startsWith("[tool] ")) continue;
    return entry.length > LAST_WORDS_LIMIT
      ? `${entry.slice(0, LAST_WORDS_LIMIT).trimEnd()}…`
      : entry;
  }
  return null;
}

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
