import type { AgentAdapter } from "../adapters/adapter.js";
import { withRunLimits } from "../adapters/watchdog.js";
import type { WorkerProfile } from "../config/maya-config.js";

export interface Plan {
  /** One instruction per task, in the order they should be merged. */
  tasks: string[];
  /** False when this is the request unchanged because planning did not happen. */
  generated: boolean;
  /** What the Operator wanted to say about the split, if anything. */
  note?: string;
}

/**
 * More than this and the split is doing harm, not good: every task is an
 * agent run with its own cost, its own worktree and its own merge.
 */
export const MAX_PLANNED_TASKS = 6;

/**
 * Turns one request into the task list the Operator hands out.
 *
 * This is the thing that makes the Operator an agent rather than a scheduler.
 * Before it, `maya start` took the split already made — from `argv` — so a
 * one-line request could never become three tasks, and the Operator's own
 * profile was never dispatched to anything.
 *
 * Deliberately conservative. A plan that cannot be parsed, an operator that
 * is not configured, a tool that is unavailable, an empty answer: each falls
 * back to one task carrying the request verbatim, which is exactly what Maya
 * did before. Planning is an improvement on the default, never a gate in
 * front of it.
 */
export class Planner {
  constructor(
    private readonly operator: { adapter: AgentAdapter; profile: WorkerProfile } | undefined,
  ) {}

  async plan(request: string): Promise<Plan> {
    const fallback: Plan = { tasks: [request], generated: false };
    if (!this.operator) return fallback;

    try {
      const answer = await this.ask(buildPrompt(request));
      return parsePlan(answer) ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async ask(prompt: string): Promise<string> {
    const operator = this.operator;
    if (!operator) return "";

    const handle = withRunLimits(
      await operator.adapter.start({
        agentId: operator.profile.id,
        cwd: process.cwd(),
        prompt,
        ...(operator.profile.model ? { model: operator.profile.model } : {}),
        // Splitting a request is one turn of thinking. A plan that costs more
        // than the work it plans is not worth having.
        maxTurns: 1,
      }),
      { stallTimeoutSec: operator.profile.stallTimeoutSec, maxRunSeconds: 120 },
    );

    const said: string[] = [];
    handle.onEvent((event) => {
      if (event.type === "text") said.push(event.text);
    });
    const result = await handle.waitForCompletion();
    return result.ok ? said.join("\n") : "";
  }
}

function buildPrompt(request: string): string {
  return [
    "Split this request into tasks that separate coding agents can do at the",
    "same time, or say it is one task.",
    "",
    "The request:",
    request,
    "",
    "Each task runs in its own git worktree on its own branch, and the results",
    "are merged one after another. So:",
    "",
    "- Two tasks must not need to edit the same file. That is a merge conflict",
    "  the person then has to resolve by hand.",
    "- A task that needs another task's output is not a separate task. Keep",
    "  them together.",
    `- At most ${MAX_PLANNED_TASKS} tasks. Fewer is usually better.`,
    "- If the request is one piece of work, say so with a single task. That is",
    "  a good answer, not a failure.",
    "",
    "Reply with exactly this shape and nothing else:",
    "TASK: <a complete instruction, enough for an agent that has not seen this request>",
    "TASK: <the next one, if there is one>",
    "NOTE: <one sentence on why you split it this way, or the word NONE>",
  ].join("\n");
}

/**
 * Null when the answer is unusable, so the caller falls back rather than
 * dispatching something invented from a half-read reply.
 */
export function parsePlan(answer: string): Plan | null {
  const tasks: string[] = [];
  for (const line of answer.split("\n")) {
    const match = /^\s*TASK:\s*(.+)$/i.exec(line);
    const task = match?.[1]?.trim();
    // A model that echoes the template back has not planned anything.
    if (task && !task.startsWith("<")) tasks.push(task);
  }
  if (tasks.length === 0) return null;

  const noteMatch = /^\s*NOTE:\s*(.+)$/im.exec(answer);
  const note = noteMatch?.[1]?.trim();

  return {
    // Over the cap, the extra tasks are dropped rather than the plan refused:
    // the first few are still a reasonable split, and the alternative is
    // falling back to one task, which is worse.
    tasks: tasks.slice(0, MAX_PLANNED_TASKS),
    generated: true,
    ...(note && note.toUpperCase() !== "NONE" ? { note } : {}),
  };
}

/** How the plan is put to the person before anything runs. */
export function describePlan(request: string, plan: Plan): string {
  const lines = [
    `"${request}" splits into ${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"}:`,
    "",
    ...plan.tasks.map((task, index) => `  ${index + 1}. ${task}`),
  ];
  if (plan.note) lines.push("", plan.note);
  return lines.join("\n");
}
