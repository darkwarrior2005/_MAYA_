import { describe, expect, it, vi } from "vitest";
import type { BusEvent } from "@maya/shared-types";
import { OPERATOR_PANE, PaneStore, sanitize, totalTokens } from "../src/tui/pane-state.js";
import { decodeKeys } from "../src/tui/keys.js";
import { isSlashCommand, runSlashCommand, type SlashContext } from "../src/tui/slash-commands.js";

let nextId = 0;
const event = (partial: Partial<BusEvent> & Pick<BusEvent, "type" | "payload">): BusEvent => ({
  id: ++nextId,
  channel: "main",
  agentId: null,
  createdAt: new Date().toISOString(),
  ...partial,
});

const store = (): PaneStore =>
  new PaneStore(
    { id: OPERATOR_PANE, title: "Operator" },
    [
      { id: "worker-claude", title: "Worker (Claude)" },
      { id: "worker-copilot", title: "Worker (Copilot)" },
    ],
  );

describe("PaneStore routing", () => {
  it("sends a worker's own output to its pane", () => {
    const panes = store();
    panes.apply(
      event({
        agentId: "worker-copilot",
        type: "text",
        payload: { type: "text", agentId: "worker-copilot", text: "wrote the file" },
      }),
    );
    expect(panes.workers[1]?.lines).toContain("wrote the file");
    expect(panes.workers[0]?.lines).toHaveLength(0);
    expect(panes.operator.lines).toHaveLength(0);
  });

  it("keeps the Operator's decisions in the main pane even when they name a worker", () => {
    const panes = store();
    panes.apply(
      event({
        agentId: "worker-claude",
        type: "merge_result",
        payload: {
          type: "merge_result",
          taskId: "t1",
          branch: "maya/t1/worker-claude",
          merged: false,
          conflicts: ["src/a.ts"],
        },
      }),
    );
    expect(panes.operator.lines.join("\n")).toContain("merge blocked");
    expect(panes.workers[0]?.lines).toHaveLength(0);
  });

  it("puts output from an agent with no pane of its own in front of the user", () => {
    const panes = store();
    panes.apply(
      event({
        agentId: "maya",
        type: "error",
        payload: { type: "error", agentId: "maya", message: "snapshot write failed", fatal: false },
      }),
    );
    expect(panes.operator.lines.join("\n")).toContain("snapshot write failed");
  });

  it("ignores a replayed event it has already shown", () => {
    const panes = store();
    const text = event({
      agentId: "worker-claude",
      type: "text",
      payload: { type: "text", agentId: "worker-claude", text: "once" },
    });
    panes.apply(text);
    // A reconnect replays from the last seen id, so the boundary event arrives
    // twice; showing it twice would duplicate lines in the pane.
    panes.apply(text);
    expect(panes.workers[0]?.lines.filter((line) => line === "once")).toHaveLength(1);
    expect(panes.lastSeenId).toBe(text.id);
  });

  it("takes the largest usage reading rather than summing snapshots", () => {
    const panes = store();
    for (const total of [100, 400, 900]) {
      panes.apply(
        event({
          agentId: "worker-copilot",
          type: "usage",
          payload: {
            type: "usage",
            agentId: "worker-copilot",
            usage: { inputTokens: total, outputTokens: 10 },
          },
        }),
      );
    }
    expect(panes.workers[1]?.usage.inputTokens).toBe(900);
  });

  it("counts cached tokens and the cost, which is where a real run's spend is", () => {
    const panes = store();
    // The exact figures a live Claude Code run reported for a one-line task.
    panes.apply(
      event({
        agentId: "worker-claude",
        type: "usage",
        payload: {
          type: "usage",
          agentId: "worker-claude",
          usage: {
            inputTokens: 4,
            outputTokens: 220,
            cacheReadTokens: 43_093,
            cacheWriteTokens: 49_552,
            costUsd: 0.4094506,
          },
        },
      }),
    );
    const pane = panes.workers[0];
    expect(pane && totalTokens(pane.usage)).toBe(92_869);
    expect(panes.views().workers[0]?.subtitle).toBe("93kt - $0.41");
  });

  it("caps scrollback so a long run cannot grow without bound", () => {
    const panes = store();
    for (let index = 0; index < 1200; index += 1) {
      panes.apply(
        event({
          agentId: "worker-claude",
          type: "text",
          payload: { type: "text", agentId: "worker-claude", text: `line ${index}` },
        }),
      );
    }
    expect(panes.workers[0]?.lines.length).toBeLessThanOrEqual(800);
    expect(panes.workers[0]?.lines.at(-1)).toBe("line 1199");
  });

  it("cycles focus across every pane in both directions", () => {
    const panes = store();
    expect(panes.focusedIndex).toBe(0);
    panes.cycleFocus(1);
    expect(panes.focused.id).toBe("worker-claude");
    panes.cycleFocus(-1);
    expect(panes.focused.id).toBe(OPERATOR_PANE);
    panes.cycleFocus(-1);
    expect(panes.focused.id).toBe("worker-copilot");
  });
});

describe("sanitize", () => {
  it("strips escape sequences an agent emitted", () => {
    expect(sanitize("\u001b[2Jhello\u001b[0m")).toBe("hello");
    expect(sanitize("a\rb")).toBe("ab");
  });
});

describe("decodeKeys", () => {
  it("reads a burst of keystrokes as a list", () => {
    expect(decodeKeys("ab\r").map((key) => key.name)).toEqual(["char", "enter"]);
    expect(decodeKeys("ab\r")[0]?.text).toBe("ab");
  });

  it("recognizes the navigation keys", () => {
    expect(decodeKeys("\u001b[A").map((key) => key.name)).toEqual(["up"]);
    expect(decodeKeys("\u001b[6~").map((key) => key.name)).toEqual(["page-down"]);
    expect(decodeKeys("\u001b[Z").map((key) => key.name)).toEqual(["shift-tab"]);
    expect(decodeKeys("\u0003").map((key) => key.name)).toEqual(["ctrl-c"]);
  });

  it("treats a pasted line as one insertion plus one Enter", () => {
    const keys = decodeKeys("add a readme\n");
    expect(keys).toHaveLength(2);
    expect(keys[0]?.text).toBe("add a readme");
  });
});

describe("slash commands", () => {
  const context = (): SlashContext & { notes: string[] } => {
    const notes: string[] = [];
    return {
      notes,
      daemonAddress: "http://127.0.0.1:4321",
      note: (text) => notes.push(text),
      focus: vi.fn(),
      paneTitles: ["Operator", "Worker"],
      quit: vi.fn(),
      openBrowser: vi.fn(async () => true),
    };
  };

  it("opens the daemon's address for /localhost and never forwards it", async () => {
    const ctx = context();
    expect(isSlashCommand("/localhost")).toBe(true);
    expect(await runSlashCommand("/localhost", ctx, () => undefined)).toBe(true);
    expect(ctx.openBrowser).toHaveBeenCalledWith("http://127.0.0.1:4321");
  });

  it("tells the user when the browser will not open instead of failing silently", async () => {
    const ctx = context();
    ctx.openBrowser = vi.fn(async () => {
      throw new Error("xdg-open not found");
    });
    await runSlashCommand("/localhost", ctx, () => undefined);
    expect(ctx.notes.join("\n")).toContain("open http://127.0.0.1:4321 yourself");
  });

  it("rejects an out-of-range /focus rather than blanking the view", async () => {
    const ctx = context();
    await runSlashCommand("/focus 9", ctx, () => undefined);
    expect(ctx.focus).not.toHaveBeenCalled();
    expect(ctx.notes.join("\n")).toContain("between 0 and 1");
  });

  it("reports an unknown command as unhandled", async () => {
    const ctx = context();
    expect(await runSlashCommand("/deploy", ctx, () => undefined)).toBe(false);
    expect(ctx.notes.join("\n")).toContain("unknown command /deploy");
  });

  it("does not mistake a task for a command", () => {
    expect(isSlashCommand("add a README")).toBe(false);
    expect(isSlashCommand("  /help")).toBe(true);
  });
});
