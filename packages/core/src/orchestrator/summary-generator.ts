import type { SimpleGit } from "simple-git";
import type { AgentAdapter } from "../adapters/adapter.js";
import { withRunLimits } from "../adapters/watchdog.js";
import type { WorkerProfile } from "../config/maya-config.js";

export interface SummaryRequest {
  /** What the worker was asked to do. */
  instruction: string;
  /** What it said while doing it, secret lines already removed. */
  transcript: string;
  /** The branch holding the work, and what to compare it against. */
  branch: string;
  base: string;
}

export interface Summary {
  /** One line, used as the commit subject. */
  subject: string;
  /** A short paragraph, used as the commit body. Empty when there is nothing to add. */
  body: string;
  /** False when this is the instruction restated because nothing else was available. */
  generated: boolean;
}

/** Git's own limit for a readable subject line. */
const SUBJECT_LIMIT = 72;

/**
 * Describes what a worker actually did.
 *
 * Before this, every "summary" in Maya was `firstLine(instruction)` — the task
 * text cut to 72 characters. The To-Do panel, the chat and the git history all
 * described what was *asked*, never what was *done*: a merge commit said "add
 * a parser" whether the agent wrote a parser or edited a README.
 *
 * The Operator's own adapter writes it, from the diff and the transcript. If
 * anything goes wrong — no operator configured, the tool unavailable, an empty
 * or unusable answer — this falls back to the old behaviour and says so in
 * `generated`. A summary is worth having, never worth failing a finished run
 * over.
 */
export class SummaryGenerator {
  constructor(
    private readonly operator: { adapter: AgentAdapter; profile: WorkerProfile } | undefined,
    private readonly git: SimpleGit,
  ) {}

  async describe(request: SummaryRequest): Promise<Summary> {
    const fallback: Summary = {
      subject: firstLine(request.instruction),
      body: "",
      generated: false,
    };
    if (!this.operator) return fallback;

    const diff = await this.diffStat(request.branch, request.base);
    // Nothing changed: there is nothing to describe that the instruction does
    // not already say, and no reason to spend a model call finding that out.
    if (!diff.trim()) return fallback;

    try {
      const answer = await this.ask(buildPrompt(request, diff));
      const parsed = parseSummary(answer);
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }

  private async diffStat(branch: string, base: string): Promise<string> {
    try {
      return await this.git.raw(["diff", "--stat", `${base}...${branch}`]);
    } catch {
      return "";
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
        // Summarising is one turn of reading. A summary that costs more than
        // the work it describes is not worth having.
        maxTurns: 1,
      }),
      { stallTimeoutSec: operator.profile.stallTimeoutSec, maxRunSeconds: 90 },
    );

    const said: string[] = [];
    handle.onEvent((event) => {
      if (event.type === "text") said.push(event.text);
    });
    const result = await handle.waitForCompletion();
    return result.ok ? said.join("\n") : "";
  }
}

function buildPrompt(request: SummaryRequest, diff: string): string {
  return [
    "Summarise what was changed, for a git commit message.",
    "",
    "The task given was:",
    request.instruction,
    "",
    "Files changed:",
    diff.trim(),
    "",
    "What the agent reported:",
    request.transcript.slice(0, 4000) || "(nothing)",
    "",
    "Reply with exactly this shape and nothing else:",
    "SUBJECT: <one line, imperative mood, at most 72 characters, no trailing full stop>",
    "BODY: <one or two sentences on what changed and why, or the word NONE>",
    "",
    "Describe what the change does, not what you were asked to do.",
  ].join("\n");
}

/** Null when the answer is unusable, so the caller falls back rather than committing noise. */
export function parseSummary(answer: string): Summary | null {
  const subjectMatch = /^\s*SUBJECT:\s*(.+)$/im.exec(answer);
  const subject = subjectMatch?.[1]?.trim().replace(/\.$/, "");
  if (!subject) return null;

  const bodyMatch = /^\s*BODY:\s*([\s\S]+)$/im.exec(answer);
  const rawBody = bodyMatch?.[1]?.trim() ?? "";
  const body = rawBody.toUpperCase() === "NONE" ? "" : rawBody;

  return {
    subject: subject.length > SUBJECT_LIMIT ? `${subject.slice(0, SUBJECT_LIMIT - 1)}…` : subject,
    body,
    generated: true,
  };
}

export function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "task";
  return line.length > SUBJECT_LIMIT ? `${line.slice(0, SUBJECT_LIMIT - 3)}...` : line;
}
