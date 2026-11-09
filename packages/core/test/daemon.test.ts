import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import type { BusEvent, ServerMessage } from "@maya/shared-types";
import { EventBus } from "../src/bus/event-bus.js";
import { EventStore } from "../src/bus/event-store.js";
import { MayaPaths } from "../src/config/maya-config.js";
import { Daemon, isLockAlive, readLock } from "../src/daemon/server.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startDaemon() {
  const root = mkdtempSync(join(tmpdir(), "maya-daemon-"));
  const paths = new MayaPaths(root);
  paths.ensureDirs();
  const store = new EventStore(paths.dbFile);
  const bus = new EventBus(store);
  const daemon = new Daemon({ paths, bus, store });
  const lock = await daemon.start();

  cleanups.push(async () => {
    await daemon.stop();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  return { paths, bus, daemon, lock };
}

function collect(url: string, until: number): Promise<BusEvent[]> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const seen: BusEvent[] = [];
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`timed out with ${seen.length} of ${until} events`));
    }, 5000);

    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as ServerMessage;
      if (message.kind !== "event") return;
      seen.push(message.event);
      if (seen.length >= until) {
        clearTimeout(timer);
        socket.close();
        resolve(seen);
      }
    });
    socket.on("error", reject);
  });
}

describe("Daemon", () => {
  it("writes a lock file naming the live process and port", async () => {
    const { paths, lock } = await startDaemon();
    const onDisk = readLock(paths);

    expect(onDisk?.pid).toBe(process.pid);
    expect(onDisk?.port).toBe(lock.port);
    expect(isLockAlive(lock)).toBe(true);
  });

  it("streams live events to a connected client", async () => {
    const { bus, daemon } = await startDaemon();
    const pending = collect(`${daemon.address.replace("http", "ws")}/ws?since=0`, 1);

    // give the socket a moment to attach before publishing
    await new Promise((r) => setTimeout(r, 100));
    bus.publish("main", "worker-a", "text", {
      type: "text",
      agentId: "worker-a",
      text: "hello from the worker",
    });

    const seen = await pending;
    expect((seen[0]?.payload as { text: string }).text).toBe("hello from the worker");
  });

  it("replays what a reconnecting client missed instead of leaving a gap", async () => {
    const { bus, daemon } = await startDaemon();

    const first = bus.publish("main", "a", "text", { type: "text", agentId: "a", text: "one" });
    bus.publish("main", "a", "text", { type: "text", agentId: "a", text: "two" });

    // A client that already rendered event #1 reconnects and asks for the rest.
    const seen = await collect(`${daemon.address.replace("http", "ws")}/ws?since=${first.id}`, 1);

    expect(seen).toHaveLength(1);
    expect((seen[0]?.payload as { text: string }).text).toBe("two");
  });

  it("reports a lock whose process is gone as dead", async () => {
    const { lock } = await startDaemon();
    expect(isLockAlive({ ...lock, pid: 999_999 })).toBe(false);
  });
});
