import { describe, expect, it } from "vitest";
import { parseCopilotLine, COPILOT_DEFAULT_ALLOWED_TOOLS } from "../src/adapters/copilot-cli.js";
import { makeAntigravityParser } from "../src/adapters/antigravity-cli.js";
import { stripAnsi } from "../src/adapters/subprocess-adapter.js";

// The lines below are trimmed from real CLI output captured on Windows, not
// invented shapes — an earlier guess at these formats was wholly wrong.

describe("stripAnsi", () => {
  it("removes the escape codes a PTY adds so JSON lines stay parseable", () => {
    expect(stripAnsi("\u001b[32m{\"type\":\"result\"}\u001b[0m")).toBe('{"type":"result"}');
  });
});

describe("Copilot CLI parsing", () => {
  it("grants permission kinds, not internal tool names", () => {
    // `--allow-tool apply_patch` silently grants nothing; `write` is the kind.
    expect(COPILOT_DEFAULT_ALLOWED_TOOLS).toContain("write");
    expect(COPILOT_DEFAULT_ALLOWED_TOOLS).not.toContain("apply_patch");
  });

  it("reads the settled assistant message", () => {
    const line = JSON.stringify({
      type: "assistant.message",
      data: { messageId: "m1", content: "PONG", toolRequests: [], model: "gpt-5.6-luna" },
    });
    expect(parseCopilotLine(line, "w")).toEqual([{ type: "text", agentId: "w", text: "PONG" }]);
  });

  it("ignores ephemeral chatter so the chat log is not flooded", () => {
    const delta = JSON.stringify({
      type: "assistant.message_delta",
      data: { deltaContent: "P" },
      ephemeral: true,
    });
    const mcp = JSON.stringify({
      type: "session.mcp_server_status_changed",
      data: { serverName: "github-mcp-server", status: "pending" },
      ephemeral: true,
    });
    expect(parseCopilotLine(delta, "w")).toEqual([]);
    expect(parseCopilotLine(mcp, "w")).toEqual([]);
  });

  it("reports tool calls and their outcome", () => {
    const start = JSON.stringify({
      type: "tool.execution_start",
      data: { toolCallId: "c1", toolName: "apply_patch", arguments: "*** Begin Patch" },
    });
    expect(parseCopilotLine(start, "w")).toEqual([
      { type: "tool_call", agentId: "w", toolName: "apply_patch", input: "*** Begin Patch" },
    ]);

    const ok = JSON.stringify({
      type: "tool.execution_complete",
      data: { toolCallId: "c1", toolName: "apply_patch", success: true },
    });
    expect(parseCopilotLine(ok, "w")[0]).toMatchObject({ type: "tool_result", ok: true });
  });

  it("treats a permission denial as fatal, since nobody can approve it", () => {
    const denied = JSON.stringify({
      type: "tool.execution_complete",
      data: {
        toolName: "apply_patch",
        success: false,
        error: { code: "denied", message: "Permission denied because no interactive user response" },
      },
    });
    const events = parseCopilotLine(denied, "w");
    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ fatal: true });
    expect((error as { message: string }).message).toContain("--allow-tool");
  });

  it("reads token counts out of the usage checkpoint", () => {
    const line = JSON.stringify({
      type: "session.usage_checkpoint",
      data: {
        accountingSnapshot: {
          tokenDetails: {
            input: { tokenCount: 3 },
            output: { tokenCount: 6 },
            cache_read: { tokenCount: 0 },
            cache_write: { tokenCount: 15041 },
          },
        },
      },
    });
    expect(parseCopilotLine(line, "w")).toEqual([
      {
        type: "usage",
        agentId: "w",
        usage: { inputTokens: 3, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 15041 },
      },
    ]);
  });

  it("carries the session id from the final result", () => {
    const line = JSON.stringify({ type: "result", exitCode: 0, sessionId: "f9a71dba" });
    expect(parseCopilotLine(line, "w")[0]).toMatchObject({
      type: "done",
      ok: true,
      sessionId: "f9a71dba",
    });
  });
});

describe("Antigravity CLI parsing", () => {
  it("joins streamed text deltas into one message per step", () => {
    const parse = makeAntigravityParser();
    const delta = (text: string, state: string) =>
      JSON.stringify({
        event: "step_update",
        step_update: { step_index: 1, state, step_type: "agent_response", text_delta: text },
      });

    expect(parse(delta("PO", "ACTIVE"), "w")).toEqual([]);
    expect(parse(delta("NG", "ACTIVE"), "w")).toEqual([]);
    expect(parse(delta("", "DONE"), "w")).toEqual([{ type: "text", agentId: "w", text: "PONG" }]);
  });

  it("reports the model from the init event", () => {
    const parse = makeAntigravityParser();
    const line = JSON.stringify({
      event: "init",
      conversation_id: "c1",
      init: { model: "gemini-3.8-flash-low", permission_mode: "request-review" },
    });
    expect(parse(line, "w")[0]).toMatchObject({ type: "status", status: "running" });
  });

  it("surfaces tool steps", () => {
    const parse = makeAntigravityParser();
    const call = JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "write_file",
        tool_info: { parameters: { Path: "hello.txt" } },
      },
    });
    expect(parse(call, "w")[0]).toMatchObject({ type: "tool_call", toolName: "write_file" });
  });

  it("maps a successful result to done with usage and conversation id", () => {
    const parse = makeAntigravityParser();
    const line = JSON.stringify({
      event: "result",
      result: {
        conversation_id: "9a7ef0f1",
        status: "SUCCESS",
        response: "done",
        usage: { input_tokens: 2047, output_tokens: 2, cache_read_tokens: 17472 },
      },
    });
    const events = parse(line, "w");
    expect(events).toContainEqual({
      type: "usage",
      agentId: "w",
      usage: { inputTokens: 2047, outputTokens: 2, cacheReadTokens: 17472 },
    });
    expect(events.at(-1)).toMatchObject({ type: "done", ok: true, sessionId: "9a7ef0f1" });
  });

  it("marks a non-SUCCESS status as a failed run", () => {
    const parse = makeAntigravityParser();
    const line = JSON.stringify({ event: "result", result: { status: "ERROR" } });
    const events = parse(line, "w");
    expect(events.some((e) => e.type === "error" && e.fatal)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", ok: false });
  });
});
