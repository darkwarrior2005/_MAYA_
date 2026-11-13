import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { RepoManager, loadConfig } from "@maya/core";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("Prepare a project for Maya (git repo + .maya state dir + default config)")
    .argument("[dir]", "project directory", ".")
    .action(async (dir: string) => {
      const repoRoot = resolve(dir);
      // `maya init ~/some-project` is how the README tells people to start,
      // and until now it failed on a directory that was not already there:
      // simple-git refuses to open a missing path, and the error — "Cannot
      // use simple-git on a directory that does not exist" — reads as a
      // broken install rather than a missing folder. Preparing a project is
      // exactly the moment to create one.
      mkdirSync(repoRoot, { recursive: true });
      const repo = new RepoManager(repoRoot);
      await repo.openOrInit();
      const config = loadConfig(repo.paths);
      console.log(`Maya initialized in ${repoRoot}`);
      console.log(`  state:    ${repo.paths.stateDir} (excluded from git)`);
      console.log(`  operator: ${config.operator.displayName} [${config.operator.tool}]`);
      console.log(`  workers:  ${config.workers.map((w) => w.id).join(", ") || "none"}`);
    });
}
