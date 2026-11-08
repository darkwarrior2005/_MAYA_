import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentId, TaskSpec, TaskState } from "@maya/shared-types";

type TaskRow = {
  id: string;
  summary: string;
  instruction: string;
  assigned_to: string | null;
  branch: string | null;
  state: string;
  created_at: string;
  updated_at: string;
};

/** Task state that outlives the process, so a restarted daemon can pick back up. */
export class TaskQueue {
  constructor(private readonly db: Database.Database) {}

  add(summary: string, instruction: string): TaskSpec {
    const now = new Date().toISOString();
    const task: TaskSpec = {
      id: randomUUID().slice(0, 8),
      summary,
      instruction,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, summary, instruction, assigned_to, branch, state, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .run(task.id, task.summary, task.instruction, task.state, now, now);
    return task;
  }

  assign(taskId: string, agentId: AgentId, branch: string): void {
    this.update(taskId, { assignedTo: agentId, branch, state: "assigned" });
  }

  setState(taskId: string, state: TaskState): void {
    this.update(taskId, { state });
  }

  private update(
    taskId: string,
    patch: { assignedTo?: AgentId; branch?: string; state?: TaskState },
  ): void {
    const now = new Date().toISOString();
    const current = this.get(taskId);
    if (!current) throw new Error(`unknown task ${taskId}`);
    this.db
      .prepare(
        `UPDATE tasks SET assigned_to = ?, branch = ?, state = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        patch.assignedTo ?? current.assignedTo ?? null,
        patch.branch ?? current.branch ?? null,
        patch.state ?? current.state,
        now,
        taskId,
      );
  }

  get(taskId: string): TaskSpec | undefined {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as
      | TaskRow
      | undefined;
    return row ? toTask(row) : undefined;
  }

  all(): TaskSpec[] {
    const rows = this.db.prepare(`SELECT * FROM tasks ORDER BY created_at ASC`).all() as TaskRow[];
    return rows.map(toTask);
  }

  pending(): TaskSpec[] {
    return this.all().filter((task) => task.state === "pending");
  }

  /** Drives the "Agents To Do" panel: who is on what, right now. */
  active(): TaskSpec[] {
    return this.all().filter(
      (task) => task.state === "assigned" || task.state === "running",
    );
  }
}

function toTask(row: TaskRow): TaskSpec {
  return {
    id: row.id,
    summary: row.summary,
    instruction: row.instruction,
    ...(row.assigned_to ? { assignedTo: row.assigned_to } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    state: row.state as TaskState,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
