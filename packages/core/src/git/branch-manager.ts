import type { SimpleGit } from "simple-git";
import type { AgentId, TaskId } from "@maya/shared-types";

export function taskBranchName(taskId: TaskId, agentId: AgentId): string {
  return `maya/${taskId}/${agentId}`;
}

export class BranchManager {
  constructor(private readonly git: SimpleGit) {}

  async baseBranch(): Promise<string> {
    const branches = await this.git.branchLocal();
    for (const candidate of ["main", "master"]) {
      if (branches.all.includes(candidate)) return candidate;
    }
    return branches.current;
  }

  /** One branch per task per worker, always cut from the base branch. */
  async createTaskBranch(taskId: TaskId, agentId: AgentId): Promise<string> {
    const name = taskBranchName(taskId, agentId);
    const base = await this.baseBranch();
    await this.git.checkout(base);
    await this.git.checkoutBranch(name, base);
    return name;
  }

  async checkout(branch: string): Promise<void> {
    await this.git.checkout(branch);
  }

  /** Commits whatever the worker left in the tree. Returns null if nothing changed. */
  async commitAll(message: string): Promise<string | null> {
    if (!(await this.stageAll())) return null;
    return this.commitStaged(message);
  }

  /**
   * Stages everything the worker left, and says whether there was anything.
   *
   * Separate from committing because the commit message is written from the
   * diff: describing the change needs the change staged, and nothing is on
   * the branch until the commit happens.
   */
  async stageAll(): Promise<boolean> {
    const status = await this.git.status();
    if (status.isClean()) return false;
    await this.git.add(["-A"]);
    return true;
  }

  /**
   * What is staged, as `--stat`, for whoever is writing the message.
   *
   * Compared against `base` when given, not HEAD: an agent that made commits
   * of its own during the run would otherwise have everything but its last
   * uncommitted edit left out of the summary.
   */
  async stagedDiffStat(base?: string): Promise<string> {
    for (const args of base
      ? [["diff", "--cached", "--stat", base], ["diff", "--cached", "--stat"]]
      : [["diff", "--cached", "--stat"]]) {
      try {
        return await this.git.raw(args);
      } catch {
        // `base` may not be reachable from a worktree cut elsewhere; fall
        // through to the plain staged diff rather than losing the summary.
      }
    }
    return "";
  }

  async commitStaged(message: string): Promise<string | null> {
    const result = await this.git.commit(message);
    return result.commit || null;
  }
}
