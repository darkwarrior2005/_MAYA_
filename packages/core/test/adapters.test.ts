import { describe, expect, it } from "vitest";
import { parseCopilotLine, COPILOT_DEFAULT_ALLOWED_TOOLS } from "../src/adapters/copilot-cli.js";
import { parseAntigravityLine } from "../src/adapters/antigravity-cli.js";
import { stripAnsi } from "../src/adapters/pty-adapter.js";

describe("stripAnsi", () => {
  it("removes the escape codes a PTY adds so JSON lines stay parseable", () => {
    expect(stripAnsi("\u001b[32m{\"type\":\"result\"}\u001b[0m")).toBe('{"type":"result"}');
  });
});

describe("Copilot CLI parsing", () => {
  it("keeps a scoped tool allowlist rather than granting everything", () => {
    expect(COPILOT_DEFAULT_ALLOWED_TOOLS).not.toContain("all");
    expect(COPILOT_DEFAULT_ALLOWED_TOOLS.length).toBeGreaterThan(0);
  });

  it("maps assistant text, tool calls, and results onto normalized events", () => {
    expect(parseCopilotLine('{"type":"assistant","text":"hi"}', "w")).toEqual([
      { type: "text", agentId: "w", text: "hi" },
    ]);

    expect(parseCopilotLine('{"type":"tool_call","name":"shell","input":{"cmd":"ls"}}', "w")).toEqual(
      [{ type: "tool_call", agentId: "w", toolName: "shell", input: { cmd: "ls" } }],
    );

    const result = parseCopilotLine(
      '{"type":"result","usage":{"input_tokens":10,"output_tokens":5}}',
      "w",
    );
    expect(result).toContainEqual({
      type: "usage",
      agentId: "w",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(result.at(-1)).toMatchObject({ type: "done", ok: true });
  });

  it("surfaces unrecognized output as text instead of dropping it", () => {
    // These tools' headless JSON shapes are not fully documented, so unknown
    // lines must still reach the user.
    expect(parseCopilotLine("Building project...", "w")).toEqual([
      { type: "text", agentId: "w", text: "Building project..." },
    ]);
    expect(parseCopilotLine('{"type":"something_new","x":1}', "w")[0]?.type).toBe("text");
  });

  it("marks an errored result as not ok", () => {
    const events = parseCopilotLine('{"type":"result","is_error":true}', "w");
    expect(events.at(-1)).toMatchObject({ type: "done", ok: false });
  });
});

describe("Antigravity CLI parsing", () => {
  it("reads nested assistant content blocks", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }] },
    });
    expect(parseAntigravityLine(line, "w")).toEqual([
      { type: "text", agentId: "w", text: "line one\nline two" },
    ]);
  });

  it("carries the conversation id so a run can be resumed", () => {
    const events = parseAntigravityLine(
      '{"type":"result","conversation_id":"conv-42"}',
      "w",
    );
    expect(events.at(-1)).toMatchObject({ type: "done", sessionId: "conv-42" });
  });
});
