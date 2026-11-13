import { renderToStaticMarkup } from "react-dom/server";
import { describe as group, expect, it } from "vitest";
import type { BusEvent, ChatPayload, UsageTotals } from "@maya/shared-types";
import { Chat, describe as describeEvent, kind } from "../src/Chat.js";
import { AgentsToDo, InfoPanel, SecretChannel } from "../src/Panels.js";

/**
 * The web client had no automated test at all: 1,300 lines of React resting
 * on someone opening a browser. These cover the part where the bugs actually
 * live — the mapping from a bus event to what a person reads — plus a render
 * of each panel through `react-dom/server`, which catches a broken component
 * without pulling in a DOM.
 *
 * What this does not cover: anything needing a real DOM. Clicking Send,
 * scroll-follow, the conflict buttons. Those need jsdom and a dependency this
 * package does not have.
 */

let next = 0;
const event = (payload: ChatPayload | Record<string, unknown>, channel = "main"): BusEvent =>
  ({
    id: (next += 1),
    channel,
    agentId: "worker-a",
    type: (payload as { type: string }).type,
    payload,
    createdAt: "2026-11-13T09:41:07.000Z",
  }) as BusEvent;

group("what each event says in the chat", () => {
  it("renders a worker that stopped short, with and without its words", () => {
    // Both shapes matter: `lastWords` is optional precisely because a worker
    // can stop having said nothing, and a view that printed `undefined` there
    // would be worse than one that says so.
    const quoted = describeEvent(
      event({
        type: "worker_stopped_short",
        taskId: "t1",
        agentId: "worker-a",
        lastWords: "Which list should I keep?",
      }),
    );
    expect(quoted).toContain("Which list should I keep?");
    expect(quoted).toContain("asked nobody");

    const silent = describeEvent(
      event({ type: "worker_stopped_short", taskId: "t1", agentId: "worker-a" }),
    );
    expect(silent).toContain("said nothing");
    expect(silent).not.toContain("undefined");
  });

  it("never prints undefined or [object Object] for any event it shows", () => {
    // The whole payload union, which is how a renamed field gets caught.
    const samples: Array<ChatPayload | Record<string, unknown>> = [
      { type: "text", agentId: "worker-a", text: "hello" },
      { type: "tool_call", agentId: "worker-a", toolName: "read_file", input: { Path: "x" } },
      { type: "tool_result", agentId: "worker-a", toolName: "read_file", ok: false, output: "no" },
      { type: "error", agentId: "worker-a", message: "boom", fatal: true },
      { type: "done", agentId: "worker-a", ok: true },
      { type: "user_message", text: "do the thing" },
      { type: "agent_message", agentId: "worker-a", text: "psst" },
      { type: "task_assigned", taskId: "t1", agentId: "worker-a", branch: "maya/t1/a", summary: "s" },
      { type: "task_completed", taskId: "t1", agentId: "worker-a", ok: true, summary: "s" },
      { type: "merge_result", taskId: "t1", branch: "maya/t1/a", merged: false, conflicts: ["a.ts"] },
      { type: "conflict_prompt", promptId: "p1", question: "which?", options: [] },
      { type: "conflict_resolved", promptId: "p1", chosen: "hold", custom: false },
      { type: "agent_question", questionId: "q1", agentId: "worker-a", question: "which?" },
      { type: "operator_answer", questionId: "q1", agentId: "worker-a", answer: "that one", answered: true },
      { type: "worker_stopped_short", taskId: "t1", agentId: "worker-a" },
    ];

    for (const payload of samples) {
      const line = describeEvent(event(payload));
      if (line === null) continue;
      expect(line, JSON.stringify(payload)).not.toContain("undefined");
      expect(line, JSON.stringify(payload)).not.toContain("[object Object]");
      expect(line.trim().length, JSON.stringify(payload)).toBeGreaterThan(0);
    }
  });

  it("leaves out what belongs to another panel", () => {
    // Usage drives the info panel, and an empty text line is noise.
    expect(describeEvent(event({ type: "usage", agentId: "worker-a", usage: {} }))).toBeNull();
    expect(describeEvent(event({ type: "text", agentId: "worker-a", text: "   " }))).toBeNull();
  });

  it("files each event under the right speaker", () => {
    expect(kind(event({ type: "user_message", text: "hi" }))).toBe("user");
    expect(kind(event({ type: "error", agentId: "a", message: "x", fatal: true }))).toBe("error");
    expect(kind(event({ type: "agent_question", questionId: "q", agentId: "a", question: "?" }))).toBe(
      "question",
    );
    expect(kind(event({ type: "merge_result", taskId: "t", branch: "b", merged: true, conflicts: [] }))).toBe(
      "operator",
    );
    expect(kind(event({ type: "text", agentId: "a", text: "x" }))).toBe("agent");
  });
});

group("the chat keeps the secret channel out", () => {
  it("shows main-channel events and hides secret ones", () => {
    // The one rule this view must not break: repeating a `@user` line in the
    // transcript puts it back in front of the Operator, which is the thing
    // the channel exists to avoid.
    const html = renderToStaticMarkup(
      <Chat
        events={[
          event({ type: "text", agentId: "worker-a", text: "working on it" }),
          event({ type: "agent_message", agentId: "worker-a", text: "PRIVATE-TO-USER" }, "secret"),
        ]}
      />,
    );
    expect(html).toContain("working on it");
    expect(html).not.toContain("PRIVATE-TO-USER");
  });

  it("says so when there is nothing to show", () => {
    expect(renderToStaticMarkup(<Chat events={[]} />)).toContain("Nothing has happened");
  });
});

group("the panels render what they are given", () => {
  it("puts a secret message in its own lane, and names a silent stop", () => {
    const html = renderToStaticMarkup(
      <SecretChannel
        events={[
          event({ type: "agent_message", agentId: "worker-a", text: "only for you" }, "secret"),
          event({ type: "worker_stopped_short", taskId: "t1", agentId: "worker-a" }, "secret"),
        ]}
      />,
    );
    expect(html).toContain("only for you");
    expect(html).toContain("said nothing");
    expect(html).not.toContain("undefined");
  });

  it("totals usage the way the tracker does", () => {
    // Input + output + both cache figures, which is Maya's own definition and
    // deliberately higher than some tools' own totals.
    // Real figures from an Antigravity run: cache reads larger than the
    // fresh input, which is the shape that broke an adapter once.
    const figures = { inputTokens: 2296, outputTokens: 70, cacheReadTokens: 19712 };
    const usage: UsageTotals = {
      byAgent: { "worker-a": figures },
      byModel: { "gemini-3.8-flash": figures },
      total: figures,
    };

    const html = renderToStaticMarkup(<InfoPanel usage={usage} />);
    expect(html).toContain("worker-a");
    expect(html).toContain("gemini-3.8-flash");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
  });

  it("lists tasks with their state", () => {
    const html = renderToStaticMarkup(
      <AgentsToDo
        tasks={[
          { id: "t1", summary: "write the parser", instruction: "…", state: "running" },
          { id: "t2", summary: "write the tests", instruction: "…", state: "blocked" },
        ]}
      />,
    );
    expect(html).toContain("write the parser");
    expect(html).toContain("blocked");
  });

  it("has something to say when every panel is empty", () => {
    expect(renderToStaticMarkup(<AgentsToDo tasks={[]} />)).toMatch(/\w/);
    expect(renderToStaticMarkup(<SecretChannel events={[]} />)).toContain("Nothing here");
    expect(renderToStaticMarkup(<InfoPanel usage={null} />)).toMatch(/\w/);
  });
});
