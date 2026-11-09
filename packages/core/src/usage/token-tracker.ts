import type { AgentId, BusEvent, TokenUsage, UsageTotals } from "@maya/shared-types";

/** Input + output + both cache figures. See `docs/FINDINGS.md`. */
export function totalTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

/**
 * Rolls the event log up into what the Info Panel shows.
 *
 * Two things make this less obvious than summing:
 *
 * Copilot reports a cumulative snapshot on every checkpoint while Claude Code
 * reports a run total once, so within one agent's run the largest reading is
 * the run's usage; adding them would multiply Copilot's figures by the number
 * of checkpoints. Totals across agents are then summed normally.
 *
 * And a usage event does not name a model. The model is taken from the last
 * `status` event that mentioned one for that agent, which is how the Claude
 * Code adapter reports it (`model claude-opus-5`). An agent that never
 * announced a model is counted under "unknown" rather than dropped.
 */
export function aggregateUsage(events: Iterable<BusEvent>): UsageTotals {
  const byAgent: Record<AgentId, TokenUsage> = {};
  const byModel: Record<string, TokenUsage> = {};
  const modelOf = new Map<AgentId, string>();

  for (const event of events) {
    const payload = event.payload;
    const agentId = event.agentId ?? "maya";

    if (payload.type === "status" && payload.detail?.startsWith("model ")) {
      modelOf.set(agentId, payload.detail.slice("model ".length).trim());
      continue;
    }

    const usage =
      payload.type === "usage" ? payload.usage : payload.type === "done" ? payload.usage : undefined;
    if (!usage) continue;

    byAgent[agentId] = largest(byAgent[agentId], usage);
  }

  for (const [agentId, usage] of Object.entries(byAgent)) {
    const model = modelOf.get(agentId) ?? "unknown";
    byModel[model] = sum(byModel[model], usage);
  }

  let total: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  for (const usage of Object.values(byAgent)) total = sum(total, usage);

  return { byAgent, byModel, total };
}

/** Within one agent's run, readings restate the same total. */
function largest(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  if (!current) return { ...next };
  return build(
    Math.max(current.inputTokens, next.inputTokens),
    Math.max(current.outputTokens, next.outputTokens),
    Math.max(current.cacheReadTokens ?? 0, next.cacheReadTokens ?? 0),
    Math.max(current.cacheWriteTokens ?? 0, next.cacheWriteTokens ?? 0),
    Math.max(current.costUsd ?? 0, next.costUsd ?? 0),
  );
}

/** Across agents and models, usage adds up. */
function sum(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  const base = current ?? { inputTokens: 0, outputTokens: 0 };
  return build(
    base.inputTokens + next.inputTokens,
    base.outputTokens + next.outputTokens,
    (base.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    (base.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
    (base.costUsd ?? 0) + (next.costUsd ?? 0),
  );
}

function build(
  inputTokens: number,
  outputTokens: number,
  cacheRead: number,
  cacheWrite: number,
  cost: number,
): TokenUsage {
  const usage: TokenUsage = { inputTokens, outputTokens };
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite;
  if (cost > 0) usage.costUsd = cost;
  return usage;
}

/**
 * The same roll-up, kept up to date as events arrive instead of recomputed.
 *
 * `aggregateUsage` walks the whole log, and the web client asks for totals on
 * every usage event — 82ms per request at 5,000 events, growing with the
 * session. The daemon keeps one of these instead: seeded once from history,
 * then O(1) per event.
 */
export class UsageTracker {
  private readonly byAgent = new Map<AgentId, TokenUsage>();
  private readonly modelOf = new Map<AgentId, string>();

  /** Catches up on a log written before this process started. */
  seed(events: Iterable<BusEvent>): this {
    for (const event of events) this.record(event);
    return this;
  }

  record(event: BusEvent): void {
    const payload = event.payload;
    const agentId = event.agentId ?? "maya";

    if (payload.type === "status" && payload.detail?.startsWith("model ")) {
      this.modelOf.set(agentId, payload.detail.slice("model ".length).trim());
      return;
    }

    const usage =
      payload.type === "usage" ? payload.usage : payload.type === "done" ? payload.usage : undefined;
    if (!usage) return;

    // Within one agent's run the readings restate the same total, so the
    // largest is the run's usage. See `aggregateUsage`.
    this.byAgent.set(agentId, largest(this.byAgent.get(agentId), usage));
  }

  totals(): UsageTotals {
    const byModel: Record<string, TokenUsage> = {};
    const byAgent: Record<AgentId, TokenUsage> = {};
    let total: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    for (const [agentId, usage] of this.byAgent) {
      byAgent[agentId] = usage;
      const model = this.modelOf.get(agentId) ?? "unknown";
      byModel[model] = sum(byModel[model], usage);
      total = sum(total, usage);
    }
    return { byAgent, byModel, total };
  }
}
