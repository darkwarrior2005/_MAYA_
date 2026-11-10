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

export class GitIdentityMissingError extends Error {
  constructor() {
    super(
      "git has no user.name or user.email configured, so it cannot make a commit.\n" +
        "  git config --global user.name  \"Your Name\"\n" +
        '  git config --global user.email "you@example.com"\n' +
        "Or set them for this repository only by dropping --global.",
    );
    this.name = "GitIdentityMissingError";
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

  /**
   * Whether git can attribute a commit on this machine.
   *
   * A fresh container or CI runner has no identity configured, and every
   * `git commit` there fails with "Please tell me who you are". Maya makes
   * commits on the user's behalf constantly, so this is worth asking about
   * before the first one rather than after.
   */
  async hasIdentity(): Promise<boolean> {
    const configured = async (key: string): Promise<boolean> => {
      try {
        return (await this.git.raw(["config", "--get", key])).trim().length > 0;
      } catch {
        // `git config --get` exits non-zero when the key is unset, which
        // simple-git surfaces as a throw. Unset is the answer, not an error.
        return false;
      }
    };
    return (await configured("user.name")) && (await configured("user.email"));
  }

  /** Opens an existing repo, or inits one with an empty first commit. */
  async openOrInit(): Promise<void> {
    await RepoManager.assertGitAvailable(this.repoRoot);
    if (!(await this.isRepo())) {
      await this.git.init();
      // Checked after `init` so the message is about this repository's
      // config too, and before the commit so the failure names the fix
      // instead of being git's own "Please tell me who you are" — which is
      // what a fresh Linux CI runner hit, three steps away from where it
      // actually surfaced.
      if (!(await this.hasIdentity())) throw new GitIdentityMissingError();
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
