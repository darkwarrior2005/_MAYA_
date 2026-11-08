import { resolve } from "node:path";
import type { Command } from "commander";
import { AdapterRegistry, ClaudeCodeAdapter, EventStore, RepoManager } from "@maya/core";
import { MayaPaths } from "@maya/core";

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .description("Check git, the event store, and each wrapped CLI's install/auth state")
    .option("-d, --dir <dir>", "project directory", ".")
    .action(async (options: { dir: string }) => {
      const repoRoot = resolve(options.dir);
      let failures = 0;

      try {
        await RepoManager.assertGitAvailable(repoRoot);
        console.log("ok    git is available");
      } catch (error) {
        failures++;
        console.log(`FAIL  ${error instanceof Error ? error.message : String(error)}`);
      }

      const paths = new MayaPaths(repoRoot);
      try {
        paths.ensureDirs();
        const store = new EventStore(paths.dbFile);
        const mode = store.journalMode;
        store.close();
        if (mode.toLowerCase() === "wal") {
          console.log("ok    event store is in WAL mode");
        } else {
          failures++;
          console.log(`FAIL  event store journal_mode is "${mode}", expected wal`);
        }
      } catch (error) {
        failures++;
        console.log(`FAIL  event store: ${error instanceof Error ? error.message : String(error)}`);
      }

      const registry = new AdapterRegistry().register(new ClaudeCodeAdapter());
      for (const adapter of registry.all()) {
        const health = await adapter.check();
        if (!health.installed) {
          failures++;
          console.log(`FAIL  ${adapter.displayName}: not installed`);
        } else if (!health.authenticated) {
          failures++;
          console.log(`WARN  ${adapter.displayName}: ${health.detail ?? "not authenticated"}`);
        } else {
          console.log(`ok    ${adapter.displayName} ready`);
        }
      }

      process.exitCode = failures === 0 ? 0 : 1;
    });
}
