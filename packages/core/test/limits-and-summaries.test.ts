import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, BusEvent } from "@maya/shared-types";
import type {
  AdapterHealth,
  AgentAdapter,
  AgentEventListener,
  AgentHandle,
  AgentRunOptions,
} from "../src/adapters/adapter.js";
import { withRunLimits } from "../src/adapters/watchdog.js";
import { EventBus } from "../src/bus/event-bus.js";
import { EventStore } from "../src/bus/event-store.js";
import { publishAgentEvent } from "../src/orchestrator/secret-channel.js";
import { SummaryGenerator, parseSummary } from "../src/orchestrator/summary-generator.js";
import {
  MAX_PLANNED_TASKS,
  Planner,
  describePlan,
  parsePlan,
} from "../src/orchestrator/planner.js";
import { UsageTracker, aggregateUsage } from "../src/usage/token-tracker.js";
import { TaskRunner } from "../src/orchestrator/task-runner.js";
import { RepoManager } from "../src/git/repo-manager.js";
import { makeTempRepo, onCleanup, runCleanups, safeRemove, StubAdapter } from "./helpers.js";

afterEach(runCleanups);

/** A handle under the caller's control, for driving the limiter. */
function controllable(): {
  handle: AgentHandle;
  emit: (event: AgentEvent) => void;
  finish: () => void;
  killed: () => boolean;
} {
  const listeners = new Set<AgentEventListener>();
  let settle: (() => void) | undefined;
  let killed = false;
  const completion = new Promise<void>((resolve) => {
    settle = resolve;
  });

  return {
    killed: () => killed,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
    finish: () => settle?.(),
    handle: {
      agentId: "worker-a",
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      waitForCompletion: async () => {
        await completion;
        return { ok: true, stalled: false };
      },
      interrupt: async () => {},
      kill: async () => {
        killed = true;
        settle?.();
      },
    },
  };
}

describe("run limits", () => {
  it("stops a run that keeps talking past its time budget", async () => {
    const driven = controllable();
    const limited = withRunLimits(driven.handle, { stallTimeoutSec: 30, maxRunSeconds: 0.3 });

    // A denied or looping agent produces output the whole time, so the
    // silence timer is re-armed forever and never fires.
    const chatter = setInterval(
      () => driven.emit({ type: "text", agentId: "worker-a", text: "still going" }),
      40,
    );
    const result = await limited.waitForCompletion();
    clearInterval(chatter);

    expect(result.ok).toBe(false);
    expect(result.stalled).toBe(false);
    expect(result.error).toContain("0.3s budget");
    expect(driven.killed()).toBe(true);
  });

  it("stops a run that goes over its token budget", async () => {
    const driven = controllable();
    const limited = withRunLimits(driven.handle, { stallTimeoutSec: 30, maxTokens: 1000 });

    const seen: AgentEvent[] = [];
    limited.onEvent((event) => seen.push(event));

    driven.emit({
      type: "usage",
      agentId: "worker-a",
      usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 2000 },
    });
    const result = await limited.waitForCompletion();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("2020 tokens");
    // Cached reads count: they are most of a run's real usage.
    expect(seen.some((event) => event.type === "error" && event.fatal)).toBe(true);
  });

  it("leaves a run inside its budget alone", async () => {
    const driven = controllable();
    const limited = withRunLimits(driven.handle, {
      stallTimeoutSec: 30,
      maxRunSeconds: 10,
      maxTokens: 10_000,
    });
    driven.emit({
      type: "usage",
      agentId: "worker-a",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    driven.finish();

    const result = await limited.waitForCompletion();
    expect(result.ok).toBe(true);
    expect(driven.killed()).toBe(false);
  });

  it("still catches silence", async () => {
    const driven = controllable();
    const limited = withRunLimits(driven.handle, { stallTimeoutSec: 0.2 });
    const result = await limited.waitForCompletion();
    expect(result.stalled).toBe(true);
    expect(result.error).toContain("no output");
  });
});

describe("the secret channel and the recorded transcript", () => {
  it("keeps a line meant for the user out of the agent's snapshot", async () => {
    const repoRoot = await makeTempRepo();
    onCleanup(() => safeRemove(repoRoot));
    const repo = new RepoManager(repoRoot);
    await repo.openOrInit();
    const store = new EventStore(repo.paths.dbFile);
    onCleanup(() => store.close());

    const adapter = new StubAdapter({
      events: [
        {
          type: "text",
          agentId: "worker-a",
          text: "Wrote the parser.\n@user the staging password is hunter2 — is that right?",
        },
      ],
      writes: { "parser.ts": "export const parse = 1;\n" },
    });

    await new TaskRunner(repo, adapter, new EventBus(store)).run({
      instruction: "add a parser",
      agent: { id: "worker-a", role: "worker", tool: "claude-code", displayName: "A" },
    });

    const snapshot = readFileSync(
      join(repo.paths.agentDir("worker-a"), "latest.md"),
      "utf8",
    );
    // The channel promises this does not go through the Operator. It used to
    // be written verbatim into the file beside the ordinary transcript.
    expect(snapshot).not.toContain("hunter2");
    expect(snapshot).not.toContain("@user");
    expect(snapshot).toContain("Wrote the parser.");
  });

  it("still delivers it to the user", () => {
    const dir = mkdtempSync(join(tmpdir(), "maya-secret-"));
    const store = new EventStore(join(dir, "state.db"));
    onCleanup(() => {
      store.close();
      safeRemove(dir);
    });
    const bus = new EventBus(store);
    const seen: BusEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    const recorded = publishAgentEvent(bus, "worker-a", {
      type: "text",
      agentId: "worker-a",
      text: "Did the thing.\n@user but which encoding?",
    });

    expect(seen.find((e) => e.channel === "secret")?.payload).toMatchObject({
      text: "but which encoding?",
    });
    expect(recorded.transcript).toBe("Did the thing.");
  });
});

describe("summaries", () => {
  const request = {
    instruction: "add a parser",
    transcript: "Wrote src/parser.ts",
    diff: " src/parser.ts | 12 ++++++++++++",
  };

  /** An operator that answers with whatever it is told to. */
  function operatorSaying(answer: string | null): AgentAdapter {
    return {
      id: "claude-code",
      displayName: "Operator",
      capabilities: { streaming: true, structuredOutput: false, resumable: false },
      async check(): Promise<AdapterHealth> {
        return { installed: true, authenticated: true };
      },
      async start(options: AgentRunOptions): Promise<AgentHandle> {
        const listeners = new Set<AgentEventListener>();
        return {
          agentId: options.agentId,
          onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          waitForCompletion: async () => {
            if (answer === null) return { ok: false, stalled: false, error: "unavailable" };
            for (const listener of listeners) {
              listener({ type: "text", agentId: options.agentId, text: answer });
            }
            return { ok: true, stalled: false };
          },
          interrupt: async () => {},
          kill: async () => {},
        };
      },
    };
  }

  const profile = {
    id: "operator",
    tool: "claude-code" as const,
    displayName: "Operator",
    stallTimeoutSec: 5,
    enabled: true,
  };

  async function repoWithChange() {
    const dir = await makeTempRepo();
    onCleanup(() => safeRemove(dir));
    const repo = new RepoManager(dir);
    await repo.openOrInit();
    const { writeFileSync } = await import("node:fs");
    await repo.git.raw(["checkout", "-b", "maya/t1/worker-a"]);
    writeFileSync(join(dir, "parser.ts"), "export const parse = 1;\n", "utf8");
    await repo.git.add(["-A"]);
    await repo.git.commit("wip");
    await repo.git.checkout("main");
    return repo;
  }

  it("describes the change rather than restating the task", async () => {
    const repo = await repoWithChange();
    const summaries = new SummaryGenerator(
      { adapter: operatorSaying("SUBJECT: Add a streaming CSV parser\nBODY: Handles quoted fields."), profile },
      repo.git,
    );

    const summary = await summaries.describe(request);
    expect(summary.subject).toBe("Add a streaming CSV parser");
    expect(summary.body).toBe("Handles quoted fields.");
    expect(summary.generated).toBe(true);
  });

  it("falls back to the task text when the operator cannot answer", async () => {
    const summaries = new SummaryGenerator({ adapter: operatorSaying(null), profile });

    const summary = await summaries.describe(request);
    // A summary is worth having, never worth failing a finished run over.
    expect(summary.subject).toBe("add a parser");
    expect(summary.generated).toBe(false);
  });

  it("falls back when no operator is configured at all", async () => {
    const summary = await new SummaryGenerator(undefined).describe(request);
    expect(summary.generated).toBe(false);
  });

  it("does not spend a model call when nothing changed", async () => {
    let started = 0;
    const counting = operatorSaying("SUBJECT: should not be asked");
    const adapter: AgentAdapter = {
      ...counting,
      start: async (options) => {
        started += 1;
        return counting.start(options);
      },
    };

    const summary = await new SummaryGenerator({ adapter, profile }).describe({
      ...request,
      diff: "",
    });
    expect(started).toBe(0);
    expect(summary.generated).toBe(false);
  });
});

describe("parseSummary", () => {
  it("reads the shape it asked for", () => {
    expect(parseSummary("SUBJECT: Add a parser\nBODY: It streams.")).toEqual({
      subject: "Add a parser",
      body: "It streams.",
      generated: true,
    });
  });

  it("treats NONE as no body", () => {
    expect(parseSummary("SUBJECT: Add a parser\nBODY: NONE")?.body).toBe("");
  });

  it("trims a subject to git's limit", () => {
    const long = `SUBJECT: ${"x".repeat(120)}`;
    expect(parseSummary(long)?.subject).toHaveLength(72);
  });

  it("refuses an answer it cannot use, so the caller falls back", () => {
    expect(parseSummary("I think the change looks fine!")).toBeNull();
    expect(parseSummary("")).toBeNull();
  });
});

describe("UsageTracker", () => {
  const event = (agentId: string | null, payload: BusEvent["payload"], id: number): BusEvent => ({
    id,
    channel: "main",
    agentId,
    type: payload.type,
    payload,
    createdAt: "2026-11-09T10:00:00.000Z",
  });

  it("agrees with a full scan of the log", () => {
    const events = [
      event("a", { type: "status", agentId: "a", status: "running", detail: "model opus" }, 1),
      event("a", { type: "usage", agentId: "a", usage: { inputTokens: 100, outputTokens: 10 } }, 2),
      event("a", { type: "usage", agentId: "a", usage: { inputTokens: 900, outputTokens: 40 } }, 3),
      event("b", { type: "usage", agentId: "b", usage: { inputTokens: 50, outputTokens: 5 } }, 4),
    ];

    // The running total and the one-shot scan must not drift apart; the
    // daemon serves the first and the tests assert the second.
    expect(new UsageTracker().seed(events).totals()).toEqual(aggregateUsage(events));
  });

  it("updates as events arrive", () => {
    const tracker = new UsageTracker();
    tracker.record(
      event("a", { type: "usage", agentId: "a", usage: { inputTokens: 10, outputTokens: 1 } }, 1),
    );
    expect(tracker.totals().total.inputTokens).toBe(10);

    tracker.record(
      event("a", { type: "usage", agentId: "a", usage: { inputTokens: 80, outputTokens: 4 } }, 2),
    );
    expect(tracker.totals().total.inputTokens).toBe(80);
  });
});

describe("planning", () => {
  const profile = {
    id: "operator",
    tool: "claude-code" as const,
    displayName: "Operator",
    stallTimeoutSec: 5,
    enabled: true,
  };

  function operatorSaying(answer: string | null): AgentAdapter {
    return {
      id: "claude-code",
      displayName: "Operator",
      capabilities: { streaming: true, structuredOutput: false, resumable: false },
      async check(): Promise<AdapterHealth> {
        return { installed: true, authenticated: true };
      },
      async start(options: AgentRunOptions): Promise<AgentHandle> {
        const listeners = new Set<AgentEventListener>();
        return {
          agentId: options.agentId,
          onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          waitForCompletion: async () => {
            if (answer === null) return { ok: false, stalled: false, error: "unavailable" };
            for (const listener of listeners) {
              listener({ type: "text", agentId: options.agentId, text: answer });
            }
            return { ok: true, stalled: false };
          },
          interrupt: async () => {},
          kill: async () => {},
        };
      },
    };
  }

  it("splits a request into tasks", async () => {
    const planner = new Planner({ adapter: operatorSaying(
      "TASK: Add a CSV parser in src/parser.ts\nTASK: Add the docs page\nNOTE: They touch different files.",
    ), profile });

    const plan = await planner.plan("add CSV support and document it");
    expect(plan.tasks).toEqual(["Add a CSV parser in src/parser.ts", "Add the docs page"]);
    expect(plan.note).toBe("They touch different files.");
    expect(plan.generated).toBe(true);
  });

  it("accepts a single task as a real answer", async () => {
    const planner = new Planner({ adapter: operatorSaying("TASK: Rename the field everywhere\nNOTE: NONE"), profile });
    const plan = await planner.plan("rename the field");
    expect(plan.tasks).toHaveLength(1);
    expect(plan.generated).toBe(true);
    expect(plan.note).toBeUndefined();
  });

  it("falls back to the request when the operator cannot answer", async () => {
    const plan = await new Planner({ adapter: operatorSaying(null), profile }).plan("do the thing");
    expect(plan).toEqual({ tasks: ["do the thing"], generated: false });
  });

  it("falls back when no operator is configured", async () => {
    const plan = await new Planner(undefined).plan("do the thing");
    expect(plan.generated).toBe(false);
  });
});

describe("parsePlan", () => {
  it("refuses an answer with no tasks in it, so the caller falls back", () => {
    expect(parsePlan("Sure! I think you should split this up a bit.")).toBeNull();
    expect(parsePlan("")).toBeNull();
  });

  it("ignores the template echoed back", () => {
    // A model that repeats the placeholder has not planned anything.
    expect(parsePlan("TASK: <a complete instruction>\nTASK: <the next one>")).toBeNull();
  });

  it("caps the split rather than refusing it", () => {
    const many = Array.from({ length: 12 }, (_u, i) => `TASK: job ${i}`).join("\n");
    const plan = parsePlan(many);
    // Every task is an agent run with its own cost, worktree and merge.
    expect(plan?.tasks).toHaveLength(MAX_PLANNED_TASKS);
    expect(plan?.tasks[0]).toBe("job 0");
  });
});

describe("describePlan", () => {
  it("puts the split in front of the person before anything runs", () => {
    const text = describePlan("add CSV support", {
      tasks: ["Add the parser", "Add the docs"],
      generated: true,
      note: "Different files.",
    });
    expect(text).toContain("splits into 2 tasks");
    expect(text).toContain("1. Add the parser");
    expect(text).toContain("Different files.");
  });
});
