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
      const repo = new RepoManager(repoRoot);
      await repo.openOrInit();
      const config = loadConfig(repo.paths);
      console.log(`Maya initialized in ${repoRoot}`);
      console.log(`  state:    ${repo.paths.stateDir} (excluded from git)`);
      console.log(`  operator: ${config.operator.displayName} [${config.operator.tool}]`);
      console.log(`  workers:  ${config.workers.map((w) => w.id).join(", ") || "none"}`);
    });
}
