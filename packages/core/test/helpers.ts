import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import type { AgentEvent } from "@maya/shared-types";
import type {
  AdapterCapabilities,
  AdapterHealth,
  AgentAdapter,
  AgentEventListener,
  AgentHandle,
  AgentRunOptions,
  AgentRunResult,
} from "../src/adapters/adapter.js";

const cleanups: Array<() => void> = [];

/** Teardown registered at setup time, so a failing assertion still releases handles. */
export function onCleanup(fn: () => void): void {
  cleanups.push(fn);
}

/**
 * Windows holds handles on git objects and the SQLite WAL slightly longer than
 * the process does, so removal retries and then gives up — leaving a temp dir
 * behind must never fail a test.
 */
export function runCleanups(): void {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup();
    } catch {
      // ignore
    }
  }
}

export function safeRemove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // the OS temp sweeper will get it
  }
}

export async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "maya-test-"));
  const git = simpleGit(dir);
  await git.init();
  await git.addConfig("user.email", "test@maya.local");
  await git.addConfig("user.name", "Maya Test");
  await git.raw(["checkout", "-B", "main"]);
  await git.raw(["commit", "--allow-empty", "-m", "init"]);
  return dir;
}

export interface StubBehavior {
  /** Events the agent emits before finishing. */
  events?: AgentEvent[];
  /**
   * Files the agent writes into the repo, as path -> contents.
   *
   * `{agent}` is replaced with the agent id in both the path and the
   * contents: in the contents so two workers write genuinely different text
   * to one path and the merge really conflicts, and in the path so a test
   * that wants them not to conflict can say so.
   */
  writes?: Record<string, string>;
  ok?: boolean;
  /** Never emit anything and never finish, to exercise the watchdog. */
  hang?: boolean;
}

export class StubAdapter implements AgentAdapter {
  readonly id = "claude-code" as const;
  readonly displayName = "Stub Agent";
  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    structuredOutput: true,
    resumable: false,
  };
  killed = false;

  constructor(private readonly behavior: StubBehavior = {}) {}

  async check(): Promise<AdapterHealth> {
    return { installed: true, authenticated: true };
  }

  async start(options: AgentRunOptions): Promise<AgentHandle> {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { dirname, join: joinPath } = await import("node:path");
    const listeners = new Set<AgentEventListener>();
    const behavior = this.behavior;

    const completion = new Promise<AgentRunResult>((resolve) => {
      if (behavior.hang) return; // never resolves; the watchdog must step in
      setTimeout(() => {
        for (const event of behavior.events ?? []) {
          for (const listener of listeners) listener(event);
        }
        for (const [relative, contents] of Object.entries(behavior.writes ?? {})) {
          const target = joinPath(options.cwd, relative.replaceAll("{agent}", options.agentId));
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, contents.replaceAll("{agent}", options.agentId), "utf8");
        }
        resolve({ ok: behavior.ok ?? true, stalled: false });
      }, 5);
    });

    return {
      agentId: options.agentId,
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      waitForCompletion: () => completion,
      interrupt: async () => {},
      kill: async () => {
        this.killed = true;
      },
    };
  }
}
