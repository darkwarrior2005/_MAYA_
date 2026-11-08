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
      const reply = (await rl.question("> ")).trim();
      const index = Number(reply);
      const picked = Number.isInteger(index) ? request.options[index - 1] : undefined;
      if (picked) return { chosen: picked.id, custom: false };
      return { chosen: reply, custom: true };
    } finally {
      rl.close();
    }
  }
}

/** Non-interactive default: always keeps the branch rather than guessing. */
export class HoldOnConflictResolver extends BusConflictResolver {
  protected async ask(): Promise<ConflictAnswer> {
    return { chosen: "hold", custom: false };
  }
}
