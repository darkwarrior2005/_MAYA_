export type AgentId = string;
export type TaskId = string;
export type EventId = number;

export type AgentToolId = "claude-code" | "copilot-cli" | "antigravity-cli";

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
  | "merge_result";

export type ChatPayload =
  | { type: "user_message"; text: string; replyToEventId?: EventId }
  | { type: "agent_message"; agentId: AgentId; text: string }
  | { type: "task_assigned"; taskId: TaskId; agentId: AgentId; branch: string; summary: string }
  | { type: "task_completed"; taskId: TaskId; agentId: AgentId; ok: boolean; summary: string }
  | { type: "conflict_prompt"; promptId: string; question: string; options: ConflictOption[] }
  | { type: "conflict_resolved"; promptId: string; chosen: string; custom: boolean }
  | { type: "merge_result"; taskId: TaskId; branch: string; merged: boolean; conflicts: string[] };

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
