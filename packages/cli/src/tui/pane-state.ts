import type { AgentStatus, BusEvent, ConflictOption, TokenUsage } from "@maya/shared-types";
import type { PaneView } from "./layout.js";

export interface PaneSpec {
  id: string;
  title: string;
}

export interface PaneBuffer {
  id: string;
  title: string;
  lines: string[];
  status: AgentStatus | undefined;
  usage: TokenUsage;
  scrollOffset: number;
}

/** Enough history to scroll back through a run without unbounded growth. */
export const MAX_PANE_LINES = 800;

export const OPERATOR_PANE = "operator";

export interface PendingConflict {
  promptId: string;
  question: string;
  options: ConflictOption[];
}

/**
 * Events the Operator owns rather than any one worker: assignments, merges and
 * questions for the user belong in the main pane even though they name a
 * worker, because they are the Operator's decisions about that worker.
 */
const OPERATOR_EVENT_TYPES = new Set([
  "user_message",
  "agent_message",
  "task_assigned",
  "task_completed",
  "conflict_prompt",
  "conflict_resolved",
  "merge_result",
]);

/**
 * Holds what each pane shows. Kept separate from both the renderer and the
 * socket so the routing rules can be tested by feeding in bus events and
 * reading the panes back.
 */
export class PaneStore {
  readonly operator: PaneBuffer;
  readonly workers: PaneBuffer[];
  private focusIndex = 0;
  private seen = 0;
  private conflict: PendingConflict | undefined;

  constructor(operator: PaneSpec, workers: PaneSpec[]) {
    this.operator = blankPane(operator);
    this.workers = workers.map(blankPane);
  }

  /** The highest event id applied, used to resume a dropped socket. */
  get lastSeenId(): number {
    return this.seen;
  }

  /**
   * The question the Operator is waiting on, taken from the event stream
   * rather than from a resolver object. The resolver lives in whichever
   * process owns the Operator; the events reach every view, so this is what
   * lets an attached pane show the same prompt the browser shows.
   */
  get pendingConflict(): PendingConflict | undefined {
    return this.conflict;
  }

  get panes(): PaneBuffer[] {
    return [this.operator, ...this.workers];
  }

  get focused(): PaneBuffer {
    return this.panes[this.focusIndex] ?? this.operator;
  }

  focus(index: number): void {
    const panes = this.panes;
    this.focusIndex = ((index % panes.length) + panes.length) % panes.length;
  }

  cycleFocus(step: number): void {
    this.focus(this.focusIndex + step);
  }

  get focusedIndex(): number {
    return this.focusIndex;
  }

  /** Writes a line Maya itself produced, e.g. the result of a slash command. */
  note(text: string, paneId = OPERATOR_PANE): void {
    this.paneFor(paneId).lines.push(...sanitize(text).split("\n"));
    trim(this.paneFor(paneId));
  }

  apply(event: BusEvent): void {
    // Replay overlaps live delivery after a reconnect; applying an event twice
    // would duplicate lines in the pane.
    if (event.id <= this.seen) return;
    this.seen = event.id;

    const pane = this.paneFor(this.routeOf(event));
    const payload = event.payload;

    if (payload.type === "conflict_prompt") {
      this.conflict = {
        promptId: payload.promptId,
        question: payload.question,
        options: payload.options,
      };
    }
    if (payload.type === "conflict_resolved" && this.conflict?.promptId === payload.promptId) {
      this.conflict = undefined;
    }

    if (payload.type === "status") pane.status = payload.status;
    if (payload.type === "done") pane.status = payload.ok ? "done" : "error";
    if (payload.type === "usage") pane.usage = mergeUsage(pane.usage, payload.usage);
    if (payload.type === "done" && payload.usage) {
      pane.usage = mergeUsage(pane.usage, payload.usage);
    }

    const text = formatEvent(event);
    if (text === null) return;
    pane.lines.push(...sanitize(text).split("\n"));
    trim(pane);
  }

  /** The pane an event belongs in: its own agent's, or the Operator's. */
  routeOf(event: BusEvent): string {
    if (OPERATOR_EVENT_TYPES.has(event.type)) return OPERATOR_PANE;
    const agentId = event.agentId;
    if (agentId && this.workers.some((worker) => worker.id === agentId)) return agentId;
    return OPERATOR_PANE;
  }

  private paneFor(id: string): PaneBuffer {
    return this.workers.find((worker) => worker.id === id) ?? this.operator;
  }

  views(): { operator: PaneView; workers: PaneView[] } {
    const toView = (pane: PaneBuffer, index: number): PaneView => ({
      id: pane.id,
      title: pane.title,
      lines: pane.lines,
      scrollOffset: pane.scrollOffset,
      focused: this.focusIndex === index,
      ...(annotate(pane) ? { subtitle: annotate(pane) } : {}),
    });
    return {
      operator: toView(this.operator, 0),
      workers: this.workers.map((pane, index) => toView(pane, index + 1)),
    };
  }
}

function blankPane(spec: PaneSpec): PaneBuffer {
  return {
    id: spec.id,
    title: spec.title,
    lines: [],
    status: undefined,
    usage: { inputTokens: 0, outputTokens: 0 },
    scrollOffset: 0,
  };
}

function trim(pane: PaneBuffer): void {
  if (pane.lines.length <= MAX_PANE_LINES) return;
  pane.lines.splice(0, pane.lines.length - MAX_PANE_LINES);
}

/**
 * Copilot reports a cumulative snapshot on every checkpoint while Claude Code
 * reports a run total once, so the larger of the two readings is the run's
 * usage. Adding them would multiply Copilot's numbers by the checkpoint count.
 */
function mergeUsage(current: TokenUsage, next: TokenUsage): TokenUsage {
  const merged: TokenUsage = {
    inputTokens: Math.max(current.inputTokens, next.inputTokens),
    outputTokens: Math.max(current.outputTokens, next.outputTokens),
  };
  const cacheRead = Math.max(current.cacheReadTokens ?? 0, next.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(current.cacheWriteTokens ?? 0, next.cacheWriteTokens ?? 0);
  const cost = Math.max(current.costUsd ?? 0, next.costUsd ?? 0);
  if (cacheRead > 0) merged.cacheReadTokens = cacheRead;
  if (cacheWrite > 0) merged.cacheWriteTokens = cacheWrite;
  if (cost > 0) merged.costUsd = cost;
  return merged;
}

function annotate(pane: PaneBuffer): string {
  const parts: string[] = [];
  if (pane.status) parts.push(pane.status);
  const tokens = totalTokens(pane.usage);
  if (tokens > 0) parts.push(compact(tokens));
  if (pane.usage.costUsd !== undefined) parts.push(`$${pane.usage.costUsd.toFixed(2)}`);
  return parts.join(" - ");
}

/**
 * Cached tokens count. A real Claude Code run on a one-line task reported 4
 * input and 220 output tokens against 43k cache reads and 49k cache writes, so
 * a header adding only the first two claims 224 tokens for a run that actually
 * moved 93k and cost 41 cents.
 */
export function totalTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

function compact(tokens: number): string {
  if (tokens < 1000) return `${tokens}t`;
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}kt`;
}

/**
 * Agent output is arbitrary text and may carry escape sequences of its own;
 * letting those through would let a worker repaint or scroll Maya's frame.
 */
/* eslint-disable no-control-regex -- matching terminal control characters
   is the point here: this is what strips them out of agent output. */
export function sanitize(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/** One pane line per event, or null for events with nothing to show. */
export function formatEvent(event: BusEvent): string | null {
  const payload = event.payload;
  const who = event.agentId ?? "maya";

  switch (payload.type) {
    case "text":
      return payload.text.trimEnd() || null;
    case "tool_call":
      return `  - ${payload.toolName}`;
    case "tool_result":
      return payload.ok ? null : `  - ${payload.toolName} failed`;
    case "status":
      return `-- ${payload.status}${payload.detail ? `: ${payload.detail}` : ""}`;
    case "usage":
      return null;
    case "error":
      return `${payload.fatal ? "error" : "warning"}: ${payload.message}`;
    case "done":
      return payload.ok ? "-- done" : "-- done (failed)";
    case "user_message":
      return `you: ${payload.text}`;
    case "agent_message":
      return `${payload.agentId}: ${payload.text}`;
    case "task_assigned":
      return `>> ${payload.agentId}: ${payload.summary} [${payload.branch}]`;
    case "task_completed":
      return `${payload.agentId} finished ${payload.ok ? "ok" : "with errors"}`;
    case "merge_result":
      return payload.merged
        ? `merged ${payload.branch}`
        : `merge blocked: ${payload.branch} (${payload.conflicts.join(", ") || "unclean tree"})`;
    case "conflict_prompt":
      return `needs a decision: ${payload.question}`;
    case "conflict_resolved":
      return `decided: ${payload.chosen}`;
    default:
      return `${who}: ${event.type}`;
  }
}
