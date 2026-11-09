import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EventBus } from "../src/bus/event-bus.js";
import { EventStore } from "../src/bus/event-store.js";
import { DeferredConflictResolver, parseConflictReply } from "../src/orchestrator/conflict-resolver.js";
import { onCleanup, runCleanups, safeRemove } from "./helpers.js";

afterEach(runCleanups);

function makeBus(): EventBus {
  const dir = mkdtempSync(join(tmpdir(), "maya-conflict-"));
  const store = new EventStore(join(dir, "state.db"));
  onCleanup(() => {
    store.close();
    safeRemove(dir);
  });
  return new EventBus(store);
}

const request = {
  question: "two branches touch src/a.ts. How should this be handled?",
  options: [
    { id: "hold", label: "Keep the work on its branch" },
    { id: "discard", label: "Abandon the branch" },
  ],
};

describe("parseConflictReply", () => {
  it("reads a bare number as the matching option", () => {
    expect(parseConflictReply(request, "2")).toEqual({ chosen: "discard", custom: false });
    expect(parseConflictReply(request, " 1 ")).toEqual({ chosen: "hold", custom: false });
  });

  it("treats anything else as the user's own answer", () => {
    expect(parseConflictReply(request, "rebase it onto main")).toEqual({
      chosen: "rebase it onto main",
      custom: true,
    });
    // Out of range is an answer, not silently option 1.
    expect(parseConflictReply(request, "9")).toEqual({ chosen: "9", custom: true });
  });
});

describe("DeferredConflictResolver", () => {
  it("waits for the UI rather than reading stdin itself", async () => {
    const resolver = new DeferredConflictResolver(makeBus());
    const pending = resolver.resolve(request);

    // The question is parked and visible to whatever owns the terminal.
    await Promise.resolve();
    expect(resolver.pending?.question).toBe(request.question);

    expect(resolver.answer("2")).toBe(true);
    await expect(pending).resolves.toEqual({ chosen: "discard", custom: false });
    expect(resolver.pending).toBeUndefined();
  });

  it("reports that nothing was waiting, so the input is not swallowed", () => {
    const resolver = new DeferredConflictResolver(makeBus());
    expect(resolver.answer("hello")).toBe(false);
  });

  it("holds the branch when the view goes away mid-question", async () => {
    const resolver = new DeferredConflictResolver(makeBus());
    const pending = resolver.resolve(request);
    await Promise.resolve();

    // Quitting the pane view must not leave the Operator blocked forever.
    resolver.abandon();
    await expect(pending).resolves.toEqual({ chosen: "hold", custom: false });
  });

  it("puts the question and the answer in the shared chat history", async () => {
    const bus = makeBus();
    const seen: string[] = [];
    bus.subscribe((event) => seen.push(event.type));

    const resolver = new DeferredConflictResolver(bus);
    const pending = resolver.resolve(request);
    await Promise.resolve();
    resolver.answer("1");
    await pending;

    expect(seen).toEqual(["conflict_prompt", "conflict_resolved"]);
  });
});
