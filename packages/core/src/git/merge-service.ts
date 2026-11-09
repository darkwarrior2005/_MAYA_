import type { SimpleGit, StatusResult } from "simple-git";

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
    if (hasTrackedChanges(preStatus)) {
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
    if (postStatus.conflicted.length > 0 || hasTrackedChanges(postStatus)) {
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

/**
 * Whether the tree holds changes a merge could destroy.
 *
 * Deliberately not `status.isClean()`, which also counts untracked files.
 * Refusing on those means refusing to merge in any repository where someone
 * has a scratch file or an un-ignored build artifact — which is most of them,
 * and it looked exactly like Maya being broken. An untracked file is only at
 * risk if the merge would write over that same path, and git refuses that
 * itself with a clear error, which lands in the catch below and is reported
 * as a conflict.
 *
 * Modified, deleted, renamed, staged and conflicted entries are a different
 * matter: a merge really can clobber those, so they still block.
 */
function hasTrackedChanges(status: StatusResult): boolean {
  return (
    status.conflicted.length > 0 ||
    status.created.length > 0 ||
    status.deleted.length > 0 ||
    status.modified.length > 0 ||
    status.renamed.length > 0 ||
    status.staged.length > 0
  );
}
