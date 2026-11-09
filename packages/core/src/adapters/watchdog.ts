import type { AgentEvent, TokenUsage } from "@maya/shared-types";
import type { AgentEventListener, AgentHandle, AgentRunResult } from "./adapter.js";
import { DEFAULT_STALL_TIMEOUT_SEC } from "../config/maya-config.js";

export interface RunLimits {
  /** Seconds of silence before the run is declared stalled. */
  stallTimeoutSec?: number;
  /** Wall-clock ceiling for the whole run, however talkative it is. */
  maxRunSeconds?: number;
  /** Token ceiling, counted from the run's own usage events. */
  maxTokens?: number;
}

/**
 * Bounds a run three ways, because one way is not enough.
 *
 * Silence catches a worker hung on a prompt it cannot answer. It does not
 * catch the opposite failure: an agent that has been denied a tool, or is
 * looping, keeps producing output the whole time, so the silence timer is
 * re-armed forever while the run burns turns. A measured Claude Code run on a
 * one-line task cost $0.41, so "forever" is not free.
 *
 * The wall clock and token ceilings work off the normalized event stream, so
 * they apply to every adapter — including one a project added itself, which
 * has no native budget option to set.
 */
export function withRunLimits(handle: AgentHandle, limits: RunLimits = {}): AgentHandle {
  const listeners = new Set<AgentEventListener>();
  const stallTimeoutSec = limits.stallTimeoutSec ?? DEFAULT_STALL_TIMEOUT_SEC;

  let timer: NodeJS.Timeout | undefined;
  let runTimer: NodeJS.Timeout | undefined;
  let settled = false;
  let stopResult: AgentRunResult | undefined;
  let resolveStop: ((result: AgentRunResult) => void) | undefined;

  const stopPromise = new Promise<AgentRunResult>((resolve) => {
    resolveStop = resolve;
  });

  const emit = (event: AgentEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const clearTimers = (): void => {
    if (timer) clearTimeout(timer);
    if (runTimer) clearTimeout(runTimer);
    timer = undefined;
    runTimer = undefined;
  };

  /**
   * Ends the run the same way however the ceiling was reached: a status, a
   * fatal error, and a kill. Fatal matters — a run cut short must never be
   * read as a clean finish and merged.
   */
  const halt = (status: "stalled" | "error", detail: string, stalled: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimers();
    stopResult = { ok: false, stalled, error: detail };
    emit({ agentId: handle.agentId, type: "status", status, detail });
    emit({ agentId: handle.agentId, type: "error", message: detail, fatal: true });
    void handle.kill();
    resolveStop?.(stopResult);
  };

  const armSilence = (): void => {
    if (timer) clearTimeout(timer);
    if (settled) return;
    timer = setTimeout(
      () => halt("stalled", `no output for ${stallTimeoutSec}s — declared stalled and killed`, true),
      stallTimeoutSec * 1000,
    );
    timer.unref?.();
  };

  if (limits.maxRunSeconds !== undefined && limits.maxRunSeconds > 0) {
    runTimer = setTimeout(
      () =>
        halt(
          "error",
          `run exceeded its ${limits.maxRunSeconds}s budget and was stopped`,
          false,
        ),
      limits.maxRunSeconds * 1000,
    );
    runTimer.unref?.();
  }

  const unsubscribe = handle.onEvent((event) => {
    if (settled) return;
    armSilence();

    if (limits.maxTokens !== undefined && limits.maxTokens > 0) {
      const usage = event.type === "usage" ? event.usage : undefined;
      if (usage && totalTokens(usage) > limits.maxTokens) {
        emit(event);
        halt(
          "error",
          `run used ${totalTokens(usage)} tokens, over its ${limits.maxTokens} budget, and was stopped`,
          false,
        );
        return;
      }
    }

    emit(event);
  });

  armSilence();

  return {
    agentId: handle.agentId,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async waitForCompletion() {
      const result = await Promise.race([handle.waitForCompletion(), stopPromise]);
      settled = true;
      clearTimers();
      unsubscribe();
      return stopResult ?? result;
    },
    async interrupt() {
      await handle.interrupt();
    },
    async kill() {
      settled = true;
      clearTimers();
      unsubscribe();
      await handle.kill();
    },
  };
}

/** Cached reads and writes count; they are most of a run's real usage. */
function totalTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

/**
 * The silence-only form, kept because most callers want exactly that.
 *
 * @deprecated Prefer `withRunLimits`, which also bounds time and tokens.
 */
export function withStallWatchdog(
  handle: AgentHandle,
  stallTimeoutSec: number = DEFAULT_STALL_TIMEOUT_SEC,
): AgentHandle {
  return withRunLimits(handle, { stallTimeoutSec });
}
