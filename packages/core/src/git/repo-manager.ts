import { existsSync } from "node:fs";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { MayaPaths, excludeStateDirFromGit } from "../config/maya-config.js";

export class GitNotAvailableError extends Error {
  constructor(cause: string) {
    super(`git is not usable: ${cause}. Install git and make sure it is on PATH.`);
    this.name = "GitNotAvailableError";
  }
}

export class RepoManager {
  readonly git: SimpleGit;
  readonly paths: MayaPaths;

  constructor(readonly repoRoot: string) {
    this.git = simpleGit(repoRoot);
    this.paths = new MayaPaths(repoRoot);
  }

  /** Verifies the git binary exists before anything else depends on it. */
  static async assertGitAvailable(repoRoot: string): Promise<void> {
    try {
      await simpleGit(repoRoot).raw(["--version"]);
    } catch (error) {
      throw new GitNotAvailableError(error instanceof Error ? error.message : String(error));
    }
  }

  async isRepo(): Promise<boolean> {
    return existsSync(join(this.repoRoot, ".git")) && this.git.checkIsRepo();
  }

  /** Opens an existing repo, or inits one with an empty first commit. */
  async openOrInit(): Promise<void> {
    await RepoManager.assertGitAvailable(this.repoRoot);
    if (!(await this.isRepo())) {
      await this.git.init();
      await this.git.raw(["commit", "--allow-empty", "-m", "Initial commit (maya init)"]);
    }
    this.paths.ensureDirs();
    excludeStateDirFromGit(this.repoRoot);
  }

  async currentBranch(): Promise<string> {
    return (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim();
  }

  async isClean(): Promise<boolean> {
    return (await this.git.status()).isClean();
  }
}
