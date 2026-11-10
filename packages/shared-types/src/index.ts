export type AgentId = string;
export type TaskId = string;
export type EventId = number;

/** The tools Maya ships with. */
export type BuiltInToolId =
  | "claude-code"
  | "copilot-cli"
  | "antigravity-cli"
  | "codex-cli";

/**
 * Any tool id, including one a project added itself. The intersection with an
 * empty object keeps the built-in ids as completions without closing the type
 * to the plugins named in `.maya/config.json`.
 */
export type AgentToolId = BuiltInToolId | (string & {});

export type AgentRole = "operator" | "sub-operator" | "worker";

export type AgentStatus =
  | "idle"
  | "starting"
  | "running"
  | "waiting-on-user"
  | "stalled"
  | "done"
  | "error";

export interface AgentDescriptor {
  id: AgentId;
  role: AgentRole;
  tool: AgentToolId;
  /** Model reported by the tool, when it exposes one. */
  model?: string;
  displayName: string;
}

export type ChatChannel = "main" | "secret" | "system";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

/**
 * Normalized event emitted by every adapter, regardless of underlying tool.
 * Adapters translate their native output into this union.
 */
export type AgentEvent =
  | { type: "text"; agentId: AgentId; text: string }
  | { type: "tool_call"; agentId: AgentId; toolName: string; input?: unknown }
  | { type: "tool_result"; agentId: AgentId; toolName: string; ok: boolean; output?: unknown }
  | { type: "status"; agentId: AgentId; status: AgentStatus; detail?: string }
  | { type: "usage"; agentId: AgentId; usage: TokenUsage }
  | { type: "error"; agentId: AgentId; message: string; fatal: boolean }
  | {
      type: "done";
      agentId: AgentId;
      ok: boolean;
      /** Tool-native session handle, when resumable. */
      sessionId?: string;
      usage?: TokenUsage;
    };

export type AgentEventType = AgentEvent["type"];

/** A row as persisted in the event store and replayed to clients. */
export interface BusEvent {
  id: EventId;
  channel: ChatChannel;
  agentId: AgentId | null;
  type: AgentEventType | ChatEventType;
  payload: AgentEvent | ChatPayload;
  createdAt: string;
}

export type ChatEventType =
  | "user_message"
  | "agent_message"
  | "task_assigned"
  | "task_completed"
  | "conflict_prompt"
  | "conflict_resolved"
  | "merge_result"
  | "agent_question"
  | "operator_answer";

export type ChatPayload =
  | { type: "user_message"; text: string; replyToEventId?: EventId }
  | { type: "agent_message"; agentId: AgentId; text: string }
  | { type: "task_assigned"; taskId: TaskId; agentId: AgentId; branch: string; summary: string }
  | { type: "task_completed"; taskId: TaskId; agentId: AgentId; ok: boolean; summary: string }
  | { type: "conflict_prompt"; promptId: string; question: string; options: ConflictOption[] }
  | { type: "conflict_resolved"; promptId: string; chosen: string; custom: boolean }
  | { type: "merge_result"; taskId: TaskId; branch: string; merged: boolean; conflicts: string[] }
  /**
   * A worker asking the Operator something, via an `@operator` line in its
   * own output. The brief says sub-agents ask the Operator for information;
   * before this the only agent-initiated channel went to the human, which is
   * the thing the Operator exists to avoid.
   */
  | { type: "agent_question"; questionId: string; agentId: AgentId; question: string }
  /** The Operator's reply, from its own adapter. */
  | {
      type: "operator_answer";
      questionId: string;
      agentId: AgentId;
      answer: string;
      /** False when no Operator adapter was available to answer. */
      answered: boolean;
    };

export interface ConflictOption {
  id: string;
  label: string;
  /** Which agent proposed this option, when it came from a worker. */
  proposedBy?: AgentId;
}

export type TaskState =
  | "pending"
  | "assigned"
  | "running"
  | "awaiting-review"
  | "merged"
  | "blocked"
  | "failed";

export interface TaskSpec {
  id: TaskId;
  summary: string;
  /** Full instruction text handed to the worker agent. */
  instruction: string;
  assignedTo?: AgentId;
  branch?: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
}

export interface GitNode {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
  refs: string[];
  /** Horizontal lane assigned by the graph builder for rendering. */
  lane: number;
}

export interface GitGraph {
  nodes: GitNode[];
  head: string | null;
  currentBranch: string | null;
}

export interface UsageTotals {
  byAgent: Record<AgentId, TokenUsage>;
  byModel: Record<string, TokenUsage>;
  total: TokenUsage;
}

export interface FileNode {
  name: string;
  /** Repo-relative, forward-slashed, so a client can use it as a key. */
  path: string;
  type: "file" | "dir";
  children?: FileNode[];
}

export interface RepoTree {
  root: FileNode;
  fileCount: number;
}

/** The session summary the web client opens with. */
export interface SessionInfo {
  repoRoot: string;
  branch: string;
  clean: boolean | null;
  changedFiles: number | null;
  operator: { id: string; displayName: string; tool: AgentToolId };
  workers: Array<{ id: string; displayName: string; tool: AgentToolId; enabled: boolean }>;
  latestEventId: EventId;
}

/**
 * What the daemon sends over its WebSocket.
 *
 * Durable history and transient signals are kept apart on purpose. An event is
 * a row in the append-only log, replayable by id; a signal says only "something
 * changed, re-read it" and is never stored. Writing a row every time a file is
 * saved would bloat the session log with things no one will ever replay.
 */
export type ServerMessage =
  | { kind: "event"; event: BusEvent }
  | { kind: "signal"; signal: ServerSignal };

export type ServerSignal = "files_changed";

export * from "./agents.js";
