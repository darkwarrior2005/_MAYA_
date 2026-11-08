import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { SimpleGit } from "simple-git";
import type { AgentId, TaskId } from "@maya/shared-types";
import type { MayaPaths } from "../config/maya-config.js";
import { taskBranchName } from "./branch-manager.js";

export interface Worktree {
  branch: string;
  path: string;
}

/**
 * Workers run in parallel, and a single checkout can only have one branch at a
 * time — two agents in the same tree would overwrite each other and every
 * branch switch would yank files out from under a running process. Each task
 * therefore gets its own worktree, and the main checkout stays on the base
 * branch for the Operator to merge into.
 */
export class WorktreeManager {
  constructor(
    private readonly git: SimpleGit,
    private readonly paths: MayaPaths,
  ) {}

  private dirFor(taskId: TaskId, agentId: AgentId): string {
    return join(this.paths.stateDir, "worktrees", `${taskId}-${agentId}`);
  }

  async create(taskId: TaskId, agentId: AgentId, base: string): Promise<Worktree> {
    const branch = taskBranchName(taskId, agentId);
    const path = this.dirFor(taskId, agentId);
    if (existsSync(path)) await this.remove(path);
    await this.git.raw(["worktree", "add", "-b", branch, path, base]);
    return { branch, path };
  }

  /** Always prune git's metadata too — deleting the directory alone leaves a stale entry. */
  async remove(path: string): Promise<void> {
    try {
      await this.git.raw(["worktree", "remove", "--force", path]);
    } catch {
      rmSync(path, { recursive: true, force: true });
      await this.git.raw(["worktree", "prune"]);
    }
  }

  async list(): Promise<string[]> {
    const output = await this.git.raw(["worktree", "list", "--porcelain"]);
    return output
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim());
  }
}
