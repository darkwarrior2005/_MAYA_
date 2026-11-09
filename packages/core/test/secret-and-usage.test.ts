import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { BusEvent } from "@maya/shared-types";
import { EventBus } from "../src/bus/event-bus.js";
import { EventStore } from "../src/bus/event-store.js";
import {
  SECRET_CHANNEL_BRIEFING,
  publishAgentEvent,
  splitSecretLines,
} from "../src/orchestrator/secret-channel.js";
import { withSecretChannel } from "../src/orchestrator/task-runner.js";
import { aggregateUsage } from "../src/usage/token-tracker.js";
import { onCleanup, runCleanups, safeRemove } from "./helpers.js";

afterEach(runCleanups);

function makeBus(): { bus: EventBus; seen: BusEvent[] } {
  const dir = mkdtempSync(join(tmpdir(), "maya-secret-"));
  const store = new EventStore(join(dir, "state.db"));
  onCleanup(() => {
    store.close();
    safeRemove(dir);
  });
  const bus = new EventBus(store);
  const seen: BusEvent[] = [];
  bus.subscribe((event) => seen.push(event));
  return { bus, seen };
}

describe("splitSecretLines", () => {
  it("lifts a marked line out and leaves the rest", () => {
    const split = splitSecretLines(
      "Starting on the parser.\n@user which encoding should I assume?\nCarrying on meanwhile.",
    );
    expect(split.secret).toEqual(["which encoding should I assume?"]);
    expect(split.main).toBe("Starting on the parser.\nCarrying on meanwhile.");
  });

  it("accepts the spellings an agent will actually produce", () => {
    expect(splitSecretLines("@user: with a colon").secret).toEqual(["with a colon"]);
    expect(splitSecretLines("  @User  leading space and case").secret).toEqual([
      "leading space and case",
    ]);
    expect(splitSecretLines("@user").secret).toEqual([]);
  });

  it("leaves an email address or a mention of the word alone", () => {
    const text = "mail me at a@user.example.com\nthe @username field is required";
    expect(splitSecretLines(text).secret).toEqual([]);
    expect(splitSecretLines(text).main).toBe(text);
  });
});

describe("publishAgentEvent", () => {
  it("sends a marked line to the secret channel and the rest to main", () => {
    const { bus, seen } = makeBus();
    publishAgentEvent(bus, "worker-a", {
      type: "text",
      agentId: "worker-a",
      text: "Wrote the parser.\n@user the spec contradicts itself on line 4.",
    });

    const secret = seen.filter((event) => event.channel === "secret");
    const main = seen.filter((event) => event.channel === "main");

    expect(secret).toHaveLength(1);
    expect(secret[0]?.type).toBe("agent_message");
    expect((secret[0]?.payload as { text: string }).text).toBe(
      "the spec contradicts itself on line 4.",
    );

    // The user's copy is not a copy: the Operator's transcript never sees it.
    expect(main).toHaveLength(1);
    expect((main[0]?.payload as { text: string }).text).toBe("Wrote the parser.");
  });

  it("publishes nothing on main when the whole message was for the user", () => {
    const { bus, seen } = makeBus();
    publishAgentEvent(bus, "worker-a", {
      type: "text",
      agentId: "worker-a",
      text: "@user are these credentials the test ones?",
    });
    expect(seen.map((event) => event.channel)).toEqual(["secret"]);
  });

  it("passes every other kind of event through untouched", () => {
    const { bus, seen } = makeBus();
    publishAgentEvent(bus, "worker-a", {
      type: "tool_call",
      agentId: "worker-a",
      toolName: "Write",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.channel).toBe("main");
    expect(seen[0]?.type).toBe("tool_call");
  });
});

describe("withSecretChannel", () => {
  it("tells the agent the marker, since it cannot use one it never heard of", () => {
    const prompt = withSecretChannel("Add a README.");
    expect(prompt).toContain("Add a README.");
    expect(prompt).toContain(SECRET_CHANNEL_BRIEFING);
    expect(prompt).toContain("@user");
  });
});

describe("aggregateUsage", () => {
  const event = (
    id: number,
    agentId: string | null,
    type: BusEvent["type"],
    payload: BusEvent["payload"],
  ): BusEvent => ({
    id,
    channel: "main",
    agentId,
    type,
    payload,
    createdAt: "2026-11-09T10:00:00.000Z",
  });

  it("takes the largest reading per agent and sums across agents", () => {
    // Copilot restates a cumulative total on every checkpoint; adding them
    // would multiply its figures by the number of checkpoints.
    const totals = aggregateUsage([
      event(1, "a", "usage", {
        type: "usage",
        agentId: "a",
        usage: { inputTokens: 100, outputTokens: 10 },
      }),
      event(2, "a", "usage", {
        type: "usage",
        agentId: "a",
        usage: { inputTokens: 900, outputTokens: 40 },
      }),
      event(3, "b", "usage", {
        type: "usage",
        agentId: "b",
        usage: { inputTokens: 50, outputTokens: 5 },
      }),
    ]);

    expect(totals.byAgent["a"]).toEqual({ inputTokens: 900, outputTokens: 40 });
    expect(totals.total).toEqual({ inputTokens: 950, outputTokens: 45 });
  });

  it("counts cached tokens and cost", () => {
    const totals = aggregateUsage([
      event(1, "a", "usage", {
        type: "usage",
        agentId: "a",
        usage: {
          inputTokens: 4,
          outputTokens: 220,
          cacheReadTokens: 43_093,
          cacheWriteTokens: 49_552,
          costUsd: 0.4094506,
        },
      }),
    ]);
    expect(totals.total.cacheReadTokens).toBe(43_093);
    expect(totals.total.costUsd).toBeCloseTo(0.40945, 4);
  });

  it("attributes usage to the model the agent last announced", () => {
    const totals = aggregateUsage([
      event(1, "a", "status", {
        type: "status",
        agentId: "a",
        status: "running",
        detail: "model claude-opus-5",
      }),
      event(2, "a", "usage", {
        type: "usage",
        agentId: "a",
        usage: { inputTokens: 10, outputTokens: 2 },
      }),
      event(3, "b", "usage", {
        type: "usage",
        agentId: "b",
        usage: { inputTokens: 7, outputTokens: 1 },
      }),
    ]);

    expect(totals.byModel["claude-opus-5"]).toEqual({ inputTokens: 10, outputTokens: 2 });
    // An agent that never said which model it used is counted, not dropped.
    expect(totals.byModel["unknown"]).toEqual({ inputTokens: 7, outputTokens: 1 });
  });

  it("is empty for a session that has reported nothing", () => {
    const totals = aggregateUsage([]);
    expect(totals.total).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(Object.keys(totals.byAgent)).toEqual([]);
  });
});
