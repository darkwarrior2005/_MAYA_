import { resolve } from "node:path";
import type { Command } from "commander";
import {
  EventBus,
  EventStore,
  RepoManager,
  TaskRunner,
  loadConfig,
  loadRegistry,
} from "@maya/core";
import type { AgentDescriptor } from "@maya/shared-types";
import { printEvent } from "../render.js";

interface RunOptions {
  dir: string;
  hold?: boolean;
  timeout?: string;
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

      const profile = config.workers[0] ?? config.operator;
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
