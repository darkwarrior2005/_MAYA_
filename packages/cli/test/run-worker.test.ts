import { describe, expect, it } from "vitest";
import { defaultConfig, type MayaConfig } from "@maya/core";
import { pickWorker } from "../src/commands/run.js";

/**
 * `maya run` used to take `config.workers[0]` and ignore `enabled`, so a
 * project configured for one agent was run by another. It was found the hard
 * way: a task aimed at Codex was answered by Claude Code, twice, before the
 * cause was obvious.
 */
describe("which worker `maya run` drives", () => {
  const withEnabled = (tools: string[]): MayaConfig => ({
    ...defaultConfig(),
    workers: defaultConfig().workers.map((worker) => ({
      ...worker,
      enabled: tools.includes(worker.tool),
    })),
  });

  it("takes the enabled worker, not the first one in the file", () => {
    // codex-cli is last in the default list and claude-code is first, so this
    // is the exact shape of the bug.
    expect(pickWorker(withEnabled(["codex-cli"])).tool).toBe("codex-cli");
  });

  it("takes the first when several are enabled", () => {
    const config = withEnabled(["copilot-cli", "codex-cli"]);
    expect(pickWorker(config).tool).toBe("copilot-cli");
  });

  it("keeps the default project working out of the box", () => {
    // Only worker-claude ships enabled, and `maya run` with no configuration
    // at all is the first thing anyone does.
    expect(pickWorker(defaultConfig()).tool).toBe("claude-code");
  });

  it("falls back to the Operator when every worker is off", () => {
    // Not a nicety: `run` is the one command that should still do something
    // on a project where nobody has enabled anything.
    const config = withEnabled([]);
    expect(pickWorker(config).id).toBe(config.operator.id);
  });
});
