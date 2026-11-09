import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@maya/shared-types";
import { SubprocessAgentHandle } from "../src/adapters/subprocess-adapter.js";

/**
 * Drives the handle against a tiny node script so the transport, line
 * splitting and result logic are exercised for real rather than mocked.
 */
function runLines(
  lines: string[],
  parseLine: (line: string, agentId: string) => AgentEvent[],
  exitCode = 0,
): SubprocessAgentHandle {
  const script = `${lines
    .map((l) => `process.stdout.write(${JSON.stringify(`${l}\n`)});`)
    .join("")}process.exit(${exitCode});`;

  return new SubprocessAgentHandle(
    { agentId: "w", cwd: process.cwd(), prompt: "x" },
    { command: process.execPath, args: ["-e", script] },
    { parseLine },
  );
}

const copilotish = (line: string, agentId: string): AgentEvent[] => {
  const json = JSON.parse(line) as Record<string, unknown>;
  if (json["kind"] === "denied") {
    return [{ type: "error", agentId, message: "permission denied", fatal: true }];
  }
  if (json["kind"] === "result") {
    return [{ type: "done", agentId, ok: true, sessionId: "s1" }];
  }
  return [];
};

describe("SubprocessAgentHandle", () => {
  it("fails the run when a fatal error precedes an otherwise clean result", async () => {
    // Copilot exits 0 and reports a normal result even when every tool call
    // was denied; trusting that would merge a branch where nothing happened.
    const handle = runLines(
      [JSON.stringify({ kind: "denied" }), JSON.stringify({ kind: "result" })],
      copilotish,
      0,
    );

    const result = await handle.waitForCompletion();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("permission denied");
  });

  it("succeeds when the result is clean and nothing fatal happened", async () => {
    const handle = runLines([JSON.stringify({ kind: "result" })], copilotish, 0);
    const result = await handle.waitForCompletion();

    expect(result.ok).toBe(true);
    expect(result.sessionId).toBe("s1");
  });

  it("falls back to the exit code when the tool reports no result", async () => {
    const handle = runLines(["{}"], () => [], 3);
    const result = await handle.waitForCompletion();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("exited with code 3");
  });

  it("reassembles output split across chunk boundaries", async () => {
    const seen: string[] = [];
    const handle = new SubprocessAgentHandle(
      { agentId: "w", cwd: process.cwd(), prompt: "x" },
      {
        command: process.execPath,
        // Deliberately split one JSON line into two writes.
        args: ["-e", `process.stdout.write('{"a":1');process.stdout.write('23}\\n');`],
      },
      {
        parseLine: (line, agentId) => {
          seen.push(line);
          return [{ type: "text", agentId, text: line }];
        },
      },
    );

    await handle.waitForCompletion();
    expect(seen).toEqual(['{"a":123}']);
  });

  it("surfaces a command that does not exist as a failed start", async () => {
    const handle = new SubprocessAgentHandle(
      { agentId: "w", cwd: process.cwd(), prompt: "x" },
      { command: "maya-no-such-binary", args: [] },
      { parseLine: () => [] },
    );

    const result = await handle.waitForCompletion();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("failed to start");
  });
});
