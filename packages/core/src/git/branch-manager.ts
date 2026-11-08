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
    const status = await this.git.status();
    if (status.isClean()) return null;
    await this.git.add(["-A"]);
    const result = await this.git.commit(message);
    return result.commit || null;
  }
}
