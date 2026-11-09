import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventStore } from "../src/bus/event-store.js";
import { EventBus } from "../src/bus/event-bus.js";
import type { BusEvent } from "@maya/shared-types";

describe("EventStore", () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "maya-store-"));
    store = new EventStore(join(dir, "state.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs in WAL mode so concurrent agent writes do not lock the database", () => {
    expect(store.journalMode.toLowerCase()).toBe("wal");
  });

  it("survives many rapid writes from several agents without locking", () => {
    for (let i = 0; i < 500; i++) {
      store.append({
        channel: "main",
        agentId: `worker-${i % 4}`,
        type: "text",
        payload: { type: "text", agentId: `worker-${i % 4}`, text: `line ${i}` },
      });
    }
    expect(store.latestId()).toBe(500);
    expect(store.since(0)).toHaveLength(500);
  });

  it("replays only events a client has not seen", () => {
    const first = store.append({
      channel: "main",
      agentId: "a",
      type: "text",
      payload: { type: "text", agentId: "a", text: "one" },
    });
    store.append({
      channel: "secret",
      agentId: "b",
      type: "text",
      payload: { type: "text", agentId: "b", text: "two" },
    });

    const missed = store.since(first.id);
    expect(missed).toHaveLength(1);
    expect(missed[0]?.channel).toBe("secret");
  });

  it("keeps the secret channel separate from main", () => {
    store.append({
      channel: "main",
      agentId: "a",
      type: "text",
      payload: { type: "text", agentId: "a", text: "public" },
    });
    store.append({
      channel: "secret",
      agentId: "b",
      type: "text",
      payload: { type: "text", agentId: "b", text: "private" },
    });

    expect(store.since(0, { channel: "secret" })).toHaveLength(1);
    expect(store.since(0, { channel: "main" })).toHaveLength(1);
  });
});

describe("EventBus", () => {
  it("replays missed events then keeps the subscriber live", () => {
    const dir = mkdtempSync(join(tmpdir(), "maya-bus-"));
    const store = new EventStore(join(dir, "state.db"));
    const bus = new EventBus(store);

    bus.publish("main", "a", "text", { type: "text", agentId: "a", text: "before" });

    const seen: BusEvent[] = [];
    const unsubscribe = bus.replayAndSubscribe(0, (event) => seen.push(event));

    bus.publish("main", "a", "text", { type: "text", agentId: "a", text: "after" });

    expect(seen.map((e) => (e.payload as { text: string }).text)).toEqual(["before", "after"]);

    unsubscribe();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
