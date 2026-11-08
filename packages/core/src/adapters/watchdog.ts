import type { AgentEvent } from "@maya/shared-types";
import type { AgentEventListener, AgentHandle, AgentRunResult } from "./adapter.js";
import { DEFAULT_STALL_TIMEOUT_SEC } from "../config/maya-config.js";

/**
 * A silently hung worker is indistinguishable from a slow one, so every handle
 * runs under a liveness budget: no event within the window means the run is
 * declared stalled and killed rather than blocking the task queue forever.
 */
export function withStallWatchdog(
  handle: AgentHandle,
  stallTimeoutSec: number = DEFAULT_STALL_TIMEOUT_SEC,
): AgentHandle {
  const listeners = new Set<AgentEventListener>();
  const timeoutMs = stallTimeoutSec * 1000;

  let timer: NodeJS.Timeout | undefined;
  let settled = false;
  let stalledResult: AgentRunResult | undefined;
  let resolveStall: ((result: AgentRunResult) => void) | undefined;

  const stallPromise = new Promise<AgentRunResult>((resolve) => {
    resolveStall = resolve;
  });

  const emit = (event: AgentEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const stop = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const arm = (): void => {
    stop();
    if (settled) return;
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      stalledResult = {
        ok: false,
        stalled: true,
        error: `no output for ${stallTimeoutSec}s — declared stalled and killed`,
      };
      emit({
        agentId: handle.agentId,
        type: "status",
        status: "stalled",
        detail: `no output for ${stallTimeoutSec}s`,
      });
      emit({
        agentId: handle.agentId,
        type: "error",
        message: `agent stalled after ${stallTimeoutSec}s of silence`,
        fatal: true,
      });
      void handle.kill();
      resolveStall?.(stalledResult);
    }, timeoutMs);
    timer.unref?.();
  };

  const unsubscribe = handle.onEvent((event) => {
    if (settled) return;
    arm();
    emit(event);
  });

  arm();

  return {
    agentId: handle.agentId,
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async waitForCompletion() {
      const result = await Promise.race([handle.waitForCompletion(), stallPromise]);
      settled = true;
      stop();
      unsubscribe();
      return stalledResult ?? result;
    },
    async interrupt() {
      await handle.interrupt();
    },
    async kill() {
      settled = true;
      stop();
      unsubscribe();
      await handle.kill();
    },
  };
}
