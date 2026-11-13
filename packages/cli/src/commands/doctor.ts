import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import {
  EventStore,
  MayaPaths,
  RepoManager,
  isLockAlive,
  loadConfig,
  loadRegistry,
  looksLikeShim,
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

        // Having git is not the same as being able to commit with it. A fresh
        // machine or container has no identity, and Maya commits on the
        // user's behalf on every task.
        if (await new RepoManager(repoRoot).hasIdentity()) {
          console.log("ok    git knows who you are");
        } else {
          fail(
            "git has no user.name/user.email, so Maya cannot commit:\n" +
              '      git config --global user.name "Your Name"\n' +
              '      git config --global user.email "you@example.com"',
          );
        }
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

      const { registry, problems } = await loadRegistry(paths, config, (message) =>
        console.log(`ok    ${message}`),
      );
      for (const problem of problems) fail(problem);
      if ((config.adapters ?? []).length === 0) {
        console.log("ok    no adapter plugins configured");
      }

      const worktreeRoot = join(paths.stateDir, "worktrees");
      if (existsSync(worktreeRoot) && readdirSync(worktreeRoot).length > 0) {
        warn(
          `worktrees remain under .maya/worktrees (${readdirSync(worktreeRoot).join(", ")}) — ` +
            "a previous run did not finish; they may hold uncommitted work",
        );
      }

      const enabledTools = new Set(
        config.workers.filter((w) => w.enabled).map((w) => w.tool),
      );
      enabledTools.add(config.operator.tool);

      for (const adapter of registry.all()) {
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
          // Which binary this will actually run. Worth a line of its own
          // because it is not always the one the person has in mind: with VS
          // Code installed, `copilot` resolves to a shim under the editor's
          // directory, ahead of the real CLI. Doctor is where someone looks
          // when a tool misbehaves, and it used to say nothing about this
          // while `maya agents` did.
          if (health.resolvedPath) {
            const shim = looksLikeShim(health.resolvedPath);
            if (shim) {
              warn(
                `${label} runs ${health.resolvedPath} — a ${shim} shim, which can hide the real tool`,
              );
            } else {
              console.log(`      runs ${health.resolvedPath}`);
            }
          }
        }
      }

      process.exitCode = failures === 0 ? 0 : 1;
    });
}
