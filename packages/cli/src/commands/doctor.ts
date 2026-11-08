import { resolve } from "node:path";
import type { Command } from "commander";
import {
  EventStore,
  MayaPaths,
  RepoManager,
  buildRegistry,
  isLockAlive,
  loadConfig,
  readLock,
} from "@maya/core";

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Check git, the event store, the daemon, and each wrapped CLI's install/auth")
    .option("-d, --dir <dir>", "project directory", ".")
    .action(async (options: { dir: string }) => {
      const repoRoot = resolve(options.dir);
      const paths = new MayaPaths(repoRoot);
      let failures = 0;
      const warn = (message: string): void => console.log(`WARN  ${message}`);
      const fail = (message: string): void => {
        failures++;
        console.log(`FAIL  ${message}`);
      };

      try {
        await RepoManager.assertGitAvailable(repoRoot);
        console.log("ok    git is available");
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }

      try {
        paths.ensureDirs();
        const store = new EventStore(paths.dbFile);
        const mode = store.journalMode;
        store.close();
        if (mode.toLowerCase() === "wal") console.log("ok    event store is in WAL mode");
        else fail(`event store journal_mode is "${mode}", expected wal`);
      } catch (error) {
        fail(`event store: ${error instanceof Error ? error.message : String(error)}`);
      }

      const lock = readLock(paths);
      if (!lock) console.log("ok    no daemon running");
      else if (isLockAlive(lock)) console.log(`ok    daemon running (pid ${lock.pid}, port ${lock.port})`);
      else warn(`stale daemon lock for pid ${lock.pid} — it will be replaced on next start`);

      const config = loadConfig(paths);
      const enabledTools = new Set(
        config.workers.filter((w) => w.enabled).map((w) => w.tool),
      );
      enabledTools.add(config.operator.tool);

      for (const adapter of buildRegistry(paths).all()) {
        const health = await adapter.check();
        const required = enabledTools.has(adapter.id);
        const label = `${adapter.displayName}${required ? "" : " (not enabled)"}`;

        if (!health.installed) {
          if (required) fail(`${label}: ${health.detail ?? "not installed"}`);
          else console.log(`skip  ${label}: ${health.detail ?? "not installed"}`);
        } else if (!health.authenticated) {
          if (required) fail(`${label}: ${health.detail ?? "not authenticated"}`);
          else warn(`${label}: ${health.detail ?? "not authenticated"}`);
        } else {
          console.log(`ok    ${label}${health.detail ? ` — ${health.detail}` : ""}`);
        }
      }

      process.exitCode = failures === 0 ? 0 : 1;
    });
}
