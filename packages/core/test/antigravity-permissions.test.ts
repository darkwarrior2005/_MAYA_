import { describe, expect, it } from "vitest";
import {
  buildAntigravityArgs,
  describeBadAntigravityPermission,
} from "../src/adapters/antigravity-cli.js";
import { describeBadPermission as describeBadCopilotPermission } from "../src/adapters/copilot-cli.js";

/**
 * Antigravity was close to useless for real work: headless `agy` cannot show a
 * permission prompt, so anything needing one was auto-denied — and the run
 * still came back `status: "SUCCESS"` with an empty answer, which reads as an
 * agent that chose to do nothing rather than one that was never allowed.
 *
 * `--settings` takes permission rules for one session and never writes them
 * anywhere, so a worker profile's `allowedTools` can grant exactly what that
 * worker needs. Verified against the real tool: granted
 * `command(git status)`, Antigravity ran it and reported the branch name it
 * could only have learned by running it.
 *
 * The rule grammar here is the tool's own, not a guess: `command(npm test)`,
 * `command(*)`, `mcp(chrome-devtools/*)`.
 */
const run = (over: Record<string, unknown> = {}) => ({
  agentId: "worker-antigravity",
  cwd: "/tmp/project",
  prompt: "do the thing",
  ...over,
});

describe("what Antigravity is allowed to do", () => {
  it("accepts the shapes the tool itself uses", () => {
    for (const pattern of [
      "command(npm test)",
      "command(git status)",
      "command(*)",
      "mcp(chrome-devtools/*)",
      "mcp(buganizer/get_bugs)",
      "read_file(src/**)",
      "write_file(*)",
      "read_url(https://example.com)",
    ]) {
      expect(describeBadAntigravityPermission(pattern), pattern).toBeNull();
    }
  });

  it("catches the mistake that costs a whole run", () => {
    // Naming the tool instead of the permission over it. `run_command` is a
    // tool; the permission is `command(...)`. Antigravity would accept the
    // settings, grant nothing, deny the command, and report success.
    const problem = describeBadAntigravityPermission("run_command");
    expect(problem).toContain("not an Antigravity permission kind");
    expect(problem).toContain("command(");
  });

  it("does not accept Copilot's grammar, or lend it ours", () => {
    // Two tools, two grammars, and a worker profile copied from one to the
    // other would silently grant nothing. Each validator rejects the other's.
    expect(describeBadAntigravityPermission("write")).not.toBeNull();
    expect(describeBadAntigravityPermission("shell(git:*)")).not.toBeNull();
    expect(describeBadCopilotPermission("command(npm test)")).not.toBeNull();
  });

  it("rejects an empty or malformed pattern", () => {
    expect(describeBadAntigravityPermission("")).toContain("empty string");
    expect(describeBadAntigravityPermission("command()")).toContain("empty target");
    expect(describeBadAntigravityPermission("command(")).toContain("not a permission pattern");
  });
});

describe("passing those permissions to the tool", () => {
  const argsFor = (over: Record<string, unknown> = {}) =>
    buildAntigravityArgs(run(over) as never);

  it("passes nothing when a worker was granted nothing", () => {
    // The default, and the reason invariant 5 still holds: no `allowedTools`
    // means no `--settings`, so the permissions are exactly what they were.
    const args = argsFor();
    expect(args).toContain("--mode");
    expect(args).not.toContain("--settings");
    expect(args).not.toContain("--dangerously-skip-permissions");
    // The prompt still goes last, behind -p.
    expect(args.at(-2)).toBe("-p");
  });

  it("turns a worker's grants into session-only settings", () => {
    const args = argsFor({ allowedTools: ["command(npm test)"] });
    const settings = args[args.indexOf("--settings") + 1];
    expect(JSON.parse(settings ?? "{}")).toEqual({
      permissions: { allow: ["command(npm test)"] },
    });
    // Never the blanket flag, whatever a profile asks for.
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("carries denials too", () => {
    const args = argsFor({
      allowedTools: ["command(*)"],
      deniedTools: ["command(rm -rf /)"],
    });
    const settings = args[args.indexOf("--settings") + 1];
    expect(JSON.parse(settings ?? "{}")).toEqual({
      permissions: { allow: ["command(*)"], deny: ["command(rm -rf /)"] },
    });
  });

  it("refuses a bad pattern instead of granting nothing", () => {
    // Loudly, like Codex refuses a tool list. Dropping it would run the agent
    // with less than the profile believed it had granted, and the blame would
    // land on the agent.
    expect(() => argsFor({ allowedTools: ["run_command"] })).toThrow(
      /not an Antigravity permission kind/,
    );
  });
});
