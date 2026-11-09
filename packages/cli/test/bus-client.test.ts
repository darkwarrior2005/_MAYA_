import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Daemon, EventBus, EventStore, MayaPaths } from "@maya/core";
import { BusClient } from "../src/tui/bus-client.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startDaemon() {
  const root = mkdtempSync(join(tmpdir(), "maya-bus-"));
  const paths = new MayaPaths(root);
  paths.ensureDirs();
  const store = new EventStore(paths.dbFile);
  const bus = new EventBus(store);
  const daemon = new Daemon({ paths, bus, store });
  await daemon.start();
  cleanups.push(async () => {
    await daemon.stop();
    store.close();
  });
  return { bus, daemon };
}

describe("BusClient", () => {
  it("stops cleanly while the socket is still connecting", async () => {
    const { daemon } = await startDaemon();
    const errors: Error[] = [];
    const onError = (error: Error): void => void errors.push(error);
    process.on("uncaughtException", onError);

    const client = new BusClient({
      address: daemon.address,
      since: () => 0,
      onEvent: () => undefined,
      onNotice: () => undefined,
    });
    client.start();
    // No await: the handshake is still in flight, which is exactly when the
    // user pressing Ctrl-C used to crash the process.
    client.stop();

    await new Promise((resolve) => setTimeout(resolve, 300));
    process.off("uncaughtException", onError);
    expect(errors).toEqual([]);
  });

  it("resumes from the last event it saw after the daemon drops it", async () => {
    const { bus, daemon } = await startDaemon();
    const seen: number[] = [];
    let last = 0;

    const client = new BusClient({
      address: daemon.address,
      since: () => last,
      onEvent: (event) => {
        seen.push(event.id);
        last = event.id;
      },
      onNotice: () => undefined,
      retryMs: 50,
    });
    client.start();
    cleanups.push(() => client.stop());

    const publish = (text: string): void =>
      void bus.publish("main", "a", "text", { type: "text", agentId: "a", text });

    publish("one");
    await waitFor(() => seen.length === 1);

    // Simulate the socket dropping: the daemon terminates its clients, the
    // client reconnects with `since`, and the event published in between must
    // arrive exactly once.
    daemon.dropClients();
    publish("two");

    await waitFor(() => seen.length === 2);
    expect(new Set(seen).size).toBe(2);
  });
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out");
}
