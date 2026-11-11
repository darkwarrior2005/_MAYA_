import { resolve } from "node:path";
import type { Command } from "commander";
import {
  EventBus,
  EventStore,
  RepoManager,
  TaskRunner,
  enabledWorkers,
  loadConfig,
  loadRegistry,
} from "@maya/core";
import type { MayaConfig, WorkerProfile } from "@maya/core";
import type { AgentDescriptor } from "@maya/shared-types";
import { printEvent } from "../render.js";

interface RunOptions {
  dir: string;
  hold?: boolean;
  timeout?: string;
}

/**
 * Which agent `maya run` drives.
 *
 * The first **enabled** worker. This was `config.workers[0]`, which ignored
 * the switch entirely: a project that had turned Claude Code off and Codex on
 * still got Claude Code, and on a machine where only Codex is logged in that
 * is a run which cannot work while a working worker sits in the config. It
 * was found by trying to run a task through Codex and watching Claude Code
 * answer. `maya start` and the pane view have always filtered on `enabled`;
 * this was the one place that did not.
 *
 * Falling back to the Operator's own profile when nothing is enabled is
 * deliberate, and is why this cannot just return `undefined`: `run` is the
 * one command that should still do something useful on a project nobody has
 * configured.
 */
export function pickWorker(config: MayaConfig): WorkerProfile {
  return enabledWorkers(config)[0] ?? config.operator;
}

export function registerRun(program: Command): void {
  program
    .command("run")
    .description("Run one task through a single agent on its own branch, then merge")
    .argument("<task...>", "what the agent should do")
    .option("-d, --dir <dir>", "project directory", ".")
    .option("--hold", "leave the work on its branch instead of merging", false)
    .option("--timeout <seconds>", "stall watchdog budget")
    .action(async (taskWords: string[], options: RunOptions) => {
      const repoRoot = resolve(options.dir);
      const repo = new RepoManager(repoRoot);
      await repo.openOrInit();

      const config = loadConfig(repo.paths);
      const store = new EventStore(repo.paths.dbFile);
      const bus = new EventBus(store);

      bus.subscribe(printEvent);

      const profile = pickWorker(config);
      const agent: AgentDescriptor = {
        id: profile.id,
        role: "worker",
        tool: profile.tool,
        displayName: profile.displayName,
        ...(profile.model ? { model: profile.model } : {}),
      };

      // The worker profile decides the tool; resolving it through the registry
      // is what lets `run` exercise any adapter, including one the project
      // added itself.
      const { registry, problems } = await loadRegistry(repo.paths, config, (message) =>
        console.log(`[maya] ${message}`),
      );
      for (const problem of problems) console.error(`[maya] ${problem}`);
      const adapter = registry.get(profile.tool);
      const runner = new TaskRunner(repo, adapter, bus);
      const instruction = taskWords.join(" ");

      const outcome = await runner.run({
        instruction,
        agent,
        stallTimeoutSec: options.timeout ? Number(options.timeout) : profile.stallTimeoutSec,
        ...(profile.allowedTools ? { allowedTools: profile.allowedTools } : {}),
        ...(profile.deniedTools ? { deniedTools: profile.deniedTools } : {}),
        ...(profile.maxRunSeconds !== undefined ? { maxRunSeconds: profile.maxRunSeconds } : {}),
        ...(profile.maxTokens !== undefined ? { maxTokens: profile.maxTokens } : {}),
        ...(profile.maxTurns !== undefined ? { maxTurns: profile.maxTurns } : {}),
        ...(profile.maxBudgetUsd !== undefined ? { maxBudgetUsd: profile.maxBudgetUsd } : {}),
        ...(options.hold ? { holdForReview: true } : {}),
      });

      console.log("");
      console.log(`task      ${outcome.taskId}`);
      console.log(`branch    ${outcome.branch}`);
      console.log(`commit    ${outcome.committed ?? "(no changes)"}`);
      console.log(`merged    ${outcome.merged}`);
      if (outcome.stalled) console.log(`stalled   yes`);
      if (outcome.conflicts.length) console.log(`conflicts ${outcome.conflicts.join(", ")}`);
      if (outcome.error) console.log(`error     ${outcome.error}`);

      store.close();
      process.exitCode = outcome.ok ? 0 : 1;
    });
}
