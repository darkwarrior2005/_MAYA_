import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Daemon,
  DeferredConflictResolver,
  EventBus,
  EventStore,
  MayaPaths,
  RepoManager,
  defaultConfig,
} from "@maya/core";
import { PaneManager } from "../src/tui/pane-manager.js";
import { OPERATOR_PANE } from "../src/tui/pane-state.js";
import { Screen, type ScreenIo } from "../src/tui/screen.js";

const ESC = String.fromCharCode(27);

/** CSI sequences plus the two-character escapes Maya writes. */
const stripEscapes = (text: string): string =>
  text
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "")
    .replace(new RegExp(`${ESC}[0-9A-Za-z=><]`, "g"), "");

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * A terminal that records what was drawn. The alternate screen buffer and raw
 * mode are real side effects on a real TTY, so the pane view is only testable
 * against a stand-in.
 */
function fakeTerminal(cols = 100, rows = 30) {
  const writes: string[] = [];
  const stdin = new EventEmitter() as unknown as NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: true,
    setRawMode: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    setEncoding: () => stdin,
  });

  const stdout = new EventEmitter() as unknown as NodeJS.WriteStream;
  Object.assign(stdout, {
    isTTY: true,
    columns: cols,
    rows,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  });

  return {
    io: { stdin, stdout } as ScreenIo,
    /** Everything written to the terminal so far, escape codes included. */
    drawn: () => writes.join(""),
    type: (text: string) => stdin.emit("data", text),
    /** Changes the reported size without emitting an event, as Windows does. */
    resize: (nextCols: number, nextRows: number) => {
      Object.assign(stdout, { columns: nextCols, rows: nextRows });
    },
  };
}

async function startDaemon(options: { answerable?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "maya-panes-"));
  const paths = new MayaPaths(root);
  paths.ensureDirs();
  const store = new EventStore(paths.dbFile);
  const bus = new EventBus(store);
  // A pane answers a merge question through the daemon, the same way a
  // browser does, so the daemon needs the resolver for the answer to land.
  const conflicts = options.answerable ? new DeferredConflictResolver(bus) : undefined;
  const daemon = new Daemon({
    paths,
    bus,
    store,
    ...(conflicts
      ? {
          web: {
            repoRoot: root,
            // Through RepoManager so the CLI does not grow a direct
            // dependency on simple-git just for a test.
            git: new RepoManager(root).git,
            store,
            bus,
            config: defaultConfig(),
            conflicts,
          },
        }
      : {}),
  });
  await daemon.start();

  cleanups.push(async () => {
    await daemon.stop();
    store.close();
  });
  return { bus, daemon, conflicts };
}

async function eventually(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("PaneManager", () => {
  it("renders a worker's events in its own pane, read over the daemon socket", async () => {
    const { bus, daemon } = await startDaemon();
    const terminal = fakeTerminal();
    const panes = new PaneManager({
      daemonAddress: daemon.address,
      operator: { id: OPERATOR_PANE, title: "Operator" },
      workers: [{ id: "worker-copilot", title: "Worker (Copilot)" }],
      screen: new Screen(terminal.io),
      charset: "ascii",
    });
    cleanups.push(() => panes.stop());
    void panes.start();

    bus.publish("main", "worker-copilot", "text", {
      type: "text",
      agentId: "worker-copilot",
      text: "created docs/README.md",
    });

    await eventually(
      () => terminal.drawn().includes("created docs/README.md"),
      "the worker's line to reach its pane",
    );

    const frame = terminal.drawn();
    expect(frame).toContain("Operator");
    expect(frame).toContain("Worker (Copilot)");
    // Entered the alternate buffer rather than scribbling on the user's shell.
    expect(frame).toContain("\u001b[?1049h");
  });

  it("replays the session so far when it attaches late", async () => {
    const { bus, daemon } = await startDaemon();
    bus.publish("main", "worker-copilot", "text", {
      type: "text",
      agentId: "worker-copilot",
      text: "this happened before the panes opened",
    });

    const terminal = fakeTerminal();
    const panes = new PaneManager({
      daemonAddress: daemon.address,
      operator: { id: OPERATOR_PANE, title: "Operator" },
      workers: [{ id: "worker-copilot", title: "Worker (Copilot)" }],
      screen: new Screen(terminal.io),
      charset: "ascii",
    });
    cleanups.push(() => panes.stop());
    void panes.start();

    await eventually(
      () => terminal.drawn().includes("this happened before the panes opened"),
      "the backlog to be replayed",
    );
  });

  it("answers a parked merge question from the prompt and restores the terminal on quit", async () => {
    const { daemon, conflicts } = await startDaemon({ answerable: true });
    if (!conflicts) throw new Error("expected a resolver");
    const terminal = fakeTerminal();
    const panes = new PaneManager({
      daemonAddress: daemon.address,
      operator: { id: OPERATOR_PANE, title: "Operator" },
      workers: [{ id: "worker-copilot", title: "Worker" }],
      conflicts,
      screen: new Screen(terminal.io),
      charset: "ascii",
    });
    const closed = panes.start();

    const answered = conflicts.resolve({
      question: "src/a.ts conflicts. How should this be handled?",
      options: [
        { id: "hold", label: "Keep the branch" },
        { id: "discard", label: "Abandon it" },
      ],
    });

    await eventually(() => terminal.drawn().includes("Keep the branch"), "the question to render");
    expect(terminal.drawn()).toContain("answer>");

    terminal.type("2\r");
    await expect(answered).resolves.toEqual({ chosen: "discard", custom: false });

    terminal.type("/quit\r");
    await closed;
    // Left the alternate buffer and showed the cursor again.
    expect(terminal.drawn()).toContain("\u001b[?1049l");
    expect(terminal.drawn()).toContain("\u001b[?25h");
  });

  it("repaints from a cleared screen when the terminal changes size", async () => {
    const { daemon } = await startDaemon();
    const terminal = fakeTerminal(100, 30);
    const panes = new PaneManager({
      daemonAddress: daemon.address,
      operator: { id: OPERATOR_PANE, title: "Operator" },
      workers: [{ id: "worker-copilot", title: "Worker" }],
      screen: new Screen(terminal.io),
      charset: "ascii",
    });
    cleanups.push(() => panes.stop());
    void panes.start();

    await eventually(() => terminal.drawn().includes("Operator"), "the first frame");
    const before = terminal.drawn().length;

    // Windows delivers no "resize" event under ConPTY. Where the terminal
    // does not answer a measurement either, the polled stdout values are what
    // is left.
    terminal.resize(60, 16);

    await eventually(
      () => terminal.drawn().slice(before).includes("\u001b[2J"),
      "a cleared repaint at the new size",
    );
    const frame = terminal.drawn().slice(before);
    const widest = Math.max(
      ...frame.split("\n").map((line) => stripEscapes(line).length),
    );
    // A frame wider than the terminal wraps and scrolls the whole screen.
    expect(widest).toBeLessThanOrEqual(60);
  });

  it("takes the size the terminal reports over the one Node reports", async () => {
    const { daemon } = await startDaemon();
    // Node's view is stuck at the startup size, as it is under ConPTY.
    const terminal = fakeTerminal(200, 60);
    const panes = new PaneManager({
      daemonAddress: daemon.address,
      operator: { id: OPERATOR_PANE, title: "Operator" },
      workers: [{ id: "worker-copilot", title: "Worker" }],
      screen: new Screen(terminal.io),
      charset: "ascii",
    });
    cleanups.push(() => panes.stop());
    void panes.start();

    await eventually(() => terminal.drawn().includes("Operator"), "the first frame");
    // Maya measures the terminal; a real terminal answers on stdin. ConPTY
    // answers this and ignores the more direct `CSI 18 t`.
    await eventually(() => terminal.drawn().includes(`${ESC}[6n`), "the size probe");

    const before = terminal.drawn().length;
    terminal.type(`${ESC}[24;80R`);

    await eventually(
      () => terminal.drawn().slice(before).includes(`${ESC}[2J`),
      "a repaint at the size the terminal reported",
    );
    const rows = terminal.drawn().slice(before).split("\n").map(stripEscapes);
    expect(Math.max(...rows.map((line) => line.length))).toBe(80);
  });

  it("keeps a measurement out of the prompt, even split across two reads", async () => {
    const { daemon } = await startDaemon();
    const terminal = fakeTerminal(100, 30);
    const sent: string[] = [];
    const panes = new PaneManager({
      daemonAddress: daemon.address,
      operator: { id: OPERATOR_PANE, title: "Operator" },
      workers: [],
      onUserMessage: (text) => sent.push(text),
      screen: new Screen(terminal.io),
      charset: "ascii",
    });
    cleanups.push(() => panes.stop());
    void panes.start();
    await eventually(() => terminal.drawn().includes("Operator"), "the first frame");

    // The answer arrives in two pieces, as a real read can split it. Half of
    // it reaching the prompt would make the view unusable, since Maya asks
    // again every quarter second.
    terminal.type(`${ESC}[2`);
    terminal.type("0;90R");
    terminal.type("add a README\r");

    await eventually(() => sent.length > 0, "the typed task");
    expect(sent).toEqual(["add a README"]);
  });

  it("never hands a slash command to the agents", async () => {
    const { daemon } = await startDaemon();
    const terminal = fakeTerminal();
    const sent: string[] = [];
    const panes = new PaneManager({
      daemonAddress: daemon.address,
      operator: { id: OPERATOR_PANE, title: "Operator" },
      workers: [],
      onUserMessage: (text) => sent.push(text),
      screen: new Screen(terminal.io),
      charset: "ascii",
    });
    cleanups.push(() => panes.stop());
    void panes.start();

    terminal.type("/panes\r");
    terminal.type("add a README\r");
    await eventually(() => sent.length > 0, "the plain task to be forwarded");

    // The command stayed with Maya; only the task reached the bus.
    expect(sent).toEqual(["add a README"]);
  });
});
