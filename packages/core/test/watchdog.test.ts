import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@maya/shared-types";
import { withStallWatchdog } from "../src/adapters/watchdog.js";
import { StubAdapter } from "./helpers.js";

describe("stall watchdog", () => {
  it("declares a silent agent stalled and kills it instead of hanging forever", async () => {
    const adapter = new StubAdapter({ hang: true });
    const handle = withStallWatchdog(
      await adapter.start({ agentId: "worker-1", cwd: process.cwd(), prompt: "do nothing" }),
      0.2,
    );

    const seen: AgentEvent[] = [];
    handle.onEvent((event) => seen.push(event));

    const result = await handle.waitForCompletion();

    expect(result.stalled).toBe(true);
    expect(result.ok).toBe(false);
    expect(adapter.killed).toBe(true);
    expect(seen.some((e) => e.type === "status" && e.status === "stalled")).toBe(true);
  });

  it("lets a responsive agent finish normally", async () => {
    const adapter = new StubAdapter({
      events: [{ type: "text", agentId: "worker-1", text: "working" }],
    });
    const handle = withStallWatchdog(
      await adapter.start({ agentId: "worker-1", cwd: process.cwd(), prompt: "work" }),
      5,
    );

    const result = await handle.waitForCompletion();

    expect(result.stalled).toBe(false);
    expect(result.ok).toBe(true);
    expect(adapter.killed).toBe(false);
  });
});
