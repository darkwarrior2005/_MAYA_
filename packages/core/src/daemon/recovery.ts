import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SimpleGit } from "simple-git";
import type { TaskSpec } from "@maya/shared-types";
import type { EventStore } from "../bus/event-store.js";
import type { MayaPaths } from "../config/maya-config.js";
import { TaskQueue } from "../orchestrator/task-queue.js";
import { clearLock, isLockAlive, readLock } from "./server.js";

export interface RecoveryReport {
  /** A lock whose process is gone, now removed. */
  clearedStaleLock: number | null;
  /** Tasks left mid-flight by a daemon that died, now marked blocked. */
  orphanedTasks: TaskSpec[];
  /**
   * Worktrees still on disk under `.maya/worktrees`. Reported, never deleted:
   * a crash can leave uncommitted agent work in one.
   */
  leftoverWorktrees: string[];
}

export interface RecoveryDeps {
  paths: MayaPaths;
  git: SimpleGit;
  store: EventStore;
}

/**
 * What a daemon does about the previous one that did not shut down cleanly.
 *
 * Run before serving, when by definition nothing of this session is running
 * yet, so anything the queue still calls "running" belongs to a process that
 * is gone. Leaving those as running makes the To-Do panel claim work is in
 * flight forever.
 *
 * Deliberately non-destructive. `git worktree prune` only drops metadata for
 * directories that have already disappeared; a worktree still on disk is
 * reported and left alone, because a crash mid-run is exactly when it holds
 * work nobody committed.
 */
export async function recoverSession(deps: RecoveryDeps): Promise<RecoveryReport> {
  const report: RecoveryReport = {
    clearedStaleLock: null,
    orphanedTasks: [],
    leftoverWorktrees: [],
  };

  const lock = readLock(deps.paths);
  if (lock && !isLockAlive(lock)) {
    clearLock(deps.paths);
    report.clearedStaleLock = lock.pid;
  }

  const queue = new TaskQueue(deps.store.database);
  for (const task of queue.all()) {
    if (task.state !== "running" && task.state !== "assigned") continue;
    queue.setState(task.id, "blocked");
    report.orphanedTasks.push(task);
  }

  try {
    await deps.git.raw(["worktree", "prune"]);
    const root = join(deps.paths.stateDir, "worktrees");
    if (existsSync(root)) {
      const { readdirSync } = await import("node:fs");
      report.leftoverWorktrees = readdirSync(root).map((entry) => join(root, entry));
    }
  } catch {
    // Not a git repository yet, or git is unavailable — `maya doctor` is
    // where that gets reported, and it must not stop the daemon starting.
  }

  return report;
}

/** One line per thing recovery had to do, or nothing when it was a clean start. */
export function describeRecovery(report: RecoveryReport): string[] {
  const lines: string[] = [];
  if (report.clearedStaleLock !== null) {
    lines.push(`cleared a stale daemon lock (pid ${report.clearedStaleLock} is gone)`);
  }
  if (report.orphanedTasks.length > 0) {
    lines.push(
      `${report.orphanedTasks.length} task(s) were left mid-flight by a previous run and are now blocked: ${report.orphanedTasks
        .map((task) => task.summary)
        .join("; ")}`,
    );
  }
  if (report.leftoverWorktrees.length > 0) {
    lines.push(
      `${report.leftoverWorktrees.length} worktree(s) remain under .maya/worktrees and may hold uncommitted work: ${report.leftoverWorktrees.join(", ")}`,
    );
  }
  return lines;
}
