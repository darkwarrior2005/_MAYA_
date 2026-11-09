import { randomUUID } from "node:crypto";
import type { ConflictOption } from "@maya/shared-types";
import type { EventBus } from "../bus/event-bus.js";

export interface ConflictRequest {
  question: string;
  options: ConflictOption[];
  /** Whether the user may type an answer instead of picking an option. */
  allowCustom?: boolean;
}

export interface ConflictAnswer {
  chosen: string;
  custom: boolean;
}

export interface ConflictResolver {
  resolve(request: ConflictRequest): Promise<ConflictAnswer>;
}

/**
 * Publishes the prompt on the bus before asking, so the question is part of the
 * shared chat history rather than something only the terminal saw. The web UI
 * renders the same event as buttons in a later phase; the prompt payload is
 * identical either way.
 */
export abstract class BusConflictResolver implements ConflictResolver {
  constructor(protected readonly bus: EventBus) {}

  async resolve(request: ConflictRequest): Promise<ConflictAnswer> {
    const promptId = randomUUID().slice(0, 8);
    this.bus.publish("main", null, "conflict_prompt", {
      type: "conflict_prompt",
      promptId,
      question: request.question,
      options: request.options,
    });

    const answer = await this.ask(request);

    this.bus.publish("main", null, "conflict_resolved", {
      type: "conflict_resolved",
      promptId,
      chosen: answer.chosen,
      custom: answer.custom,
    });
    return answer;
  }

  protected abstract ask(request: ConflictRequest): Promise<ConflictAnswer>;
}

/**
 * Shared by every interactive resolver so a "2" means the same thing typed at a
 * readline prompt and typed into a TUI pane: a bare option number picks that
 * option, anything else is the user's own answer.
 */
export function parseConflictReply(request: ConflictRequest, reply: string): ConflictAnswer {
  const trimmed = reply.trim();
  const index = Number(trimmed);
  const picked =
    trimmed !== "" && Number.isInteger(index) ? request.options[index - 1] : undefined;
  if (picked) return { chosen: picked.id, custom: false };
  return { chosen: trimmed, custom: true };
}

/** Terminal implementation: numbered options, with a free-text fallback. */
export class CliConflictResolver extends BusConflictResolver {
  protected async ask(request: ConflictRequest): Promise<ConflictAnswer> {
    const { createInterface } = await import("node:readline/promises");

    process.stdout.write(`\n${request.question}\n`);
    request.options.forEach((option, index) => {
      const who = option.proposedBy ? ` (${option.proposedBy})` : "";
      process.stdout.write(`  ${index + 1}. ${option.label}${who}\n`);
    });
    if (request.allowCustom !== false) {
      process.stdout.write(`  or type your own answer\n`);
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return parseConflictReply(request, await rl.question("> "));
    } finally {
      rl.close();
    }
  }
}

/**
 * Asks nobody directly: it parks the request and waits for whatever owns the
 * terminal to answer. The pane renderer holds stdin in raw mode, so a resolver
 * that opened its own readline would swallow the user's keystrokes and leave
 * the Operator blocked on a prompt nothing could reach.
 */
export class DeferredConflictResolver extends BusConflictResolver {
  private waiting:
    | { request: ConflictRequest; settle: (answer: ConflictAnswer) => void }
    | undefined;

  /** The question currently awaiting an answer, if any. */
  get pending(): ConflictRequest | undefined {
    return this.waiting?.request;
  }

  /**
   * Answers the open question. Returns false when nothing was waiting, so the
   * caller can treat the input as an ordinary message instead of losing it.
   */
  answer(reply: string): boolean {
    const waiting = this.waiting;
    if (!waiting) return false;
    this.waiting = undefined;
    waiting.settle(parseConflictReply(waiting.request, reply));
    return true;
  }

  /** Falls back to holding the branch when the UI goes away mid-question. */
  abandon(): void {
    const waiting = this.waiting;
    if (!waiting) return;
    this.waiting = undefined;
    waiting.settle({ chosen: "hold", custom: false });
  }

  protected ask(request: ConflictRequest): Promise<ConflictAnswer> {
    return new Promise<ConflictAnswer>((settle) => {
      this.waiting = { request, settle };
    });
  }
}

/** Non-interactive default: always keeps the branch rather than guessing. */
export class HoldOnConflictResolver extends BusConflictResolver {
  protected async ask(): Promise<ConflictAnswer> {
    return { chosen: "hold", custom: false };
  }
}
