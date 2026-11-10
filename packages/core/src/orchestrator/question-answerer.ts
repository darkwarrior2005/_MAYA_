import type { AgentAdapter } from "../adapters/adapter.js";
import { withRunLimits } from "../adapters/watchdog.js";
import type { WorkerProfile } from "../config/maya-config.js";

export interface AnsweredQuestion {
  questionId: string;
  question: string;
  answer: string;
  /** False when nothing could answer it, so the worker is told to use its judgement. */
  answered: boolean;
}

/** What the Operator knows that the worker does not. */
export interface QuestionContext {
  /** The whole request, where the worker only has its own slice of it. */
  request?: string;
  /** This worker's instruction, so the answer can be about its actual job. */
  instruction: string;
  /** The other tasks in the plan, which is usually what is being asked about. */
  siblingTasks?: string[];
  /** Who is asking. */
  askedBy: string;
}

/**
 * The Operator answering a worker's `@operator` question.
 *
 * Third place the Operator runs its own adapter, alongside `Planner` and
 * `SummaryGenerator`. The brief has sub-agents asking the Operator for
 * information; until this existed the only agent-initiated channel was
 * `@user`, so a worker that needed to know something could only interrupt the
 * human — the one thing the Operator is there to prevent.
 *
 * Conservative in the same way as the Planner: no operator configured, tool
 * unavailable, empty reply, a run that failed — each gives back a plain
 * "nobody could answer, use your judgement and say what you assumed" rather
 * than a guess dressed up as an Operator ruling. A worker acting on an
 * invented answer is worse than one acting on its own judgement, because the
 * log would show the Operator having sanctioned it.
 */
export class QuestionAnswerer {
  constructor(
    private readonly operator: { adapter: AgentAdapter; profile: WorkerProfile } | undefined,
  ) {}

  get available(): boolean {
    return this.operator !== undefined;
  }

  async answer(
    questions: Array<{ questionId: string; question: string }>,
    context: QuestionContext,
  ): Promise<AnsweredQuestion[]> {
    return Promise.all(
      questions.map(async (asked) => {
        const answer = await this.answerOne(asked.question, context);
        return {
          questionId: asked.questionId,
          question: asked.question,
          answer: answer ?? UNANSWERED,
          answered: answer !== null,
        };
      }),
    );
  }

  private async answerOne(question: string, context: QuestionContext): Promise<string | null> {
    const operator = this.operator;
    if (!operator) return null;

    try {
      const handle = withRunLimits(
        await operator.adapter.start({
          agentId: operator.profile.id,
          cwd: process.cwd(),
          prompt: buildPrompt(question, context),
          ...(operator.profile.model ? { model: operator.profile.model } : {}),
          // Answering a question is one turn. An Operator that goes exploring
          // the repository to answer a worker costs more than the worker.
          maxTurns: 1,
        }),
        { stallTimeoutSec: operator.profile.stallTimeoutSec, maxRunSeconds: 120 },
      );

      const said: string[] = [];
      handle.onEvent((event) => {
        if (event.type === "text") said.push(event.text);
      });
      const result = await handle.waitForCompletion();
      if (!result.ok) return null;

      const answer = parseAnswer(said.join("\n"));
      return answer;
    } catch {
      return null;
    }
  }
}

export const UNANSWERED =
  "Nobody could answer this. Use your judgement, and say in your summary what you assumed.";

function buildPrompt(question: string, context: QuestionContext): string {
  const lines = [
    "You are the Operator coordinating several coding agents on one repository.",
    `${context.askedBy} is in the middle of a task and has asked you this:`,
    "",
    question,
    "",
    "What it was asked to do:",
    context.instruction,
  ];

  if (context.request) {
    lines.push("", "The whole request this came from:", context.request);
  }
  if (context.siblingTasks && context.siblingTasks.length > 0) {
    lines.push(
      "",
      "The other tasks running alongside it:",
      ...context.siblingTasks.map((task) => `- ${task}`),
    );
  }

  lines.push(
    "",
    "Answer in one or two sentences, as a decision it can act on. If you do not",
    "know, say so plainly and tell it what to assume — a clear assumption is",
    "worth more to it than a hedge. Do not ask it a question back; it cannot",
    "reply.",
    "",
    "Reply with exactly this shape and nothing else:",
    "ANSWER: <your answer>",
  );
  return lines.join("\n");
}

/**
 * Null when the reply is unusable, so the caller falls back to UNANSWERED
 * rather than passing a template echo or an empty line back to the worker as
 * though the Operator had ruled on it.
 */
export function parseAnswer(reply: string): string | null {
  const match = /^\s*ANSWER:\s*(.*)$/im.exec(reply);
  if (match) {
    // Labelled: take it, unless what follows the label is the template or
    // nothing. Falling through to the plain branch here handed back the whole
    // line, template and all, as though the Operator had said it.
    const answer = match[1]?.trim() ?? "";
    return answer && !answer.startsWith("<") ? answer : null;
  }

  // A model that answered plainly without the label is still an answer; only
  // an empty or template reply is not.
  const plain = reply.trim();
  if (plain && !plain.startsWith("<")) return plain.split("\n")[0]?.trim() || null;
  return null;
}
