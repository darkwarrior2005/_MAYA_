import { resolve } from "node:path";
import type { Command } from "commander";
import {
  CliConflictResolver,
  Daemon,
  EventBus,
  EventStore,
  HoldOnConflictResolver,
  Operator,
  RepoManager,
  TaskQueue,
  buildRegistry,
  enabledWorkers,
  loadConfig,
  readLock,
  isLockAlive,
} from "@maya/core";
import { printEvent } from "../render.js";

interface StartOptions {
  dir: string;
  port?: string;
  yes?: boolean;
}

export function registerStart(program: Command): void {
  program
    .command("start")
    .description("Run tasks across workers in parallel, with the Operator merging results")
    .argument("<tasks...>", "one or more tasks, each handed to its own worker")
    .option("-d, --dir <dir>", "project directory", ".")
    .option("-p, --port <port>", "port for the local daemon")
    .option("-y, --yes", "never prompt on conflicts; hold the branch instead", false)
    .action(async (tasks: string[], options: StartOptions) => {
      const repoRoot = resolve(options.dir);
      const repo = new RepoManager(repoRoot);
      await repo.openOrInit();

      const existing = readLock(repo.paths);
      if (existing && isLockAlive(existing)) {
        console.error(
          `a Maya daemon is already running for this project (pid ${existing.pid}, port ${existing.port})`,
        );
        process.exitCode = 1;
        return;
      }

      const config = loadConfig(repo.paths);
      const workers = enabledWorkers(config);
      if (workers.length === 0) {
        console.error("no enabled workers in .maya/config.json");
        process.exitCode = 1;
        return;
      }

      const store = new EventStore(repo.paths.dbFile);
      const bus = new EventBus(store);
      bus.subscribe(printEvent);

      const daemon = new Daemon({
        paths: repo.paths,
        bus,
        store,
        ...(options.port ? { port: Number(options.port) } : {}),
      });
      const lock = await daemon.start();
      console.log(`[maya] daemon on ${daemon.address} (pid ${lock.pid})`);
      console.log(`[maya] ${workers.length} worker(s): ${workers.map((w) => w.id).join(", ")}`);

      const operator = new Operator({
        repo,
        registry: buildRegistry(repo.paths),
        bus,
        queue: new TaskQueue(store.database),
        conflicts: options.yes ? new HoldOnConflictResolver(bus) : new CliConflictResolver(bus),
        workers,
      });

      try {
        const report = await operator.run(tasks);

        console.log("");
        for (const outcome of report.outcomes) {
          const state = outcome.stalled ? "stalled" : outcome.ok ? "ok" : "failed";
          console.log(`  ${outcome.agent.id.padEnd(18)} ${state.padEnd(8)} ${outcome.branch}`);
        }
        console.log("");
        console.log(`merged ${report.merged.length}: ${report.merged.join(", ") || "-"}`);
        console.log(`held   ${report.held.length}: ${report.held.join(", ") || "-"}`);

        process.exitCode = report.held.length === 0 ? 0 : 1;
      } finally {
        await daemon.stop();
        store.close();
      }
    });
}
