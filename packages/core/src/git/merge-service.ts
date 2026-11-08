import type { SimpleGit } from "simple-git";

export interface MergeOutcome {
  merged: boolean;
  branch: string;
  into: string;
  conflicts: string[];
  /** Set when the merge was abandoned and the tree restored. */
  abortedCleanly?: boolean;
  message?: string;
}

/**
 * The Operator never marks a task done off a merge attempt alone. Any unclean
 * result aborts the merge, restores the tree, and reports conflicts so the
 * orchestrator can raise a conflict_prompt instead of proceeding on a dirty tree.
 */
export class MergeService {
  constructor(private readonly git: SimpleGit) {}

  async mergeTaskBranch(branch: string, into: string): Promise<MergeOutcome> {
    const preStatus = await this.git.status();
    if (!preStatus.isClean()) {
      return {
        merged: false,
        branch,
        into,
        conflicts: preStatus.conflicted,
        message: `refusing to merge: working tree is dirty on ${preStatus.current ?? "unknown"}`,
      };
    }

    await this.git.checkout(into);

    try {
      await this.git.merge(["--no-ff", branch]);
    } catch (error) {
      const conflicts = (await this.git.status()).conflicted;
      const aborted = await this.abort();
      return {
        merged: false,
        branch,
        into,
        conflicts,
        abortedCleanly: aborted,
        message: error instanceof Error ? error.message : String(error),
      };
    }

    // simple-git can resolve without throwing while leaving conflict markers staged.
    const postStatus = await this.git.status();
    if (postStatus.conflicted.length > 0 || !postStatus.isClean()) {
      const aborted = await this.abort();
      return {
        merged: false,
        branch,
        into,
        conflicts: postStatus.conflicted,
        abortedCleanly: aborted,
        message: "merge left the tree unclean",
      };
    }

    return { merged: true, branch, into, conflicts: [] };
  }

  private async abort(): Promise<boolean> {
    try {
      await this.git.raw(["merge", "--abort"]);
      return true;
    } catch {
      return false;
    }
  }
}
