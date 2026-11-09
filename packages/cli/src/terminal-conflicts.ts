import { createInterface } from "node:readline/promises";
import type { ConflictRequest, DeferredConflictResolver } from "@maya/core";

/**
 * Answers merge questions from a plain terminal, for `maya start` without the
 * pane view.
 *
 * It reads through the same `DeferredConflictResolver` the web uses rather
 * than resolving on its own, so a question can be answered from either side
 * and whichever answers first wins. A readline prompt cannot be cancelled from
 * outside, so when the web answers first the prompt is left on screen and told
 * to ignore what the user types next — better than two answers racing into the
 * Operator.
 */
export function promptConflictsInTerminal(resolver: DeferredConflictResolver): () => void {
  let answering = false;

  const ask = async (request: ConflictRequest): Promise<void> => {
    answering = true;
    process.stdout.write(`\n${request.question}\n`);
    request.options.forEach((option, index) => {
      const who = option.proposedBy ? ` (${option.proposedBy})` : "";
      process.stdout.write(`  ${index + 1}. ${option.label}${who}\n`);
    });
    process.stdout.write("  or type your own answer — the web interface can answer this too\n");

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const reply = await rl.question("> ");
      if (!resolver.answer(reply)) {
        process.stdout.write("(already answered in the web interface)\n");
      }
    } finally {
      rl.close();
      answering = false;
    }
  };

  return resolver.onQuestion((request) => {
    if (!request || answering) return;
    void ask(request);
  });
}
