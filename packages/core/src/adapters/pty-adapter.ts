import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { IPty } from "node-pty";
import type { AgentEvent, TokenUsage } from "@maya/shared-types";
import type {
  AgentEventListener,
  AgentHandle,
  AgentRunOptions,
  AgentRunResult,
} from "./adapter.js";

export interface PtySpawnSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface PtyAdapterConfig {
  /** Where to mirror raw PTY bytes so a stall can be diagnosed after the fact. */
  rawLogPath?: string;
  /** Turns one parsed stdout line into normalized events. */
  parseLine: (line: string, agentId: string) => AgentEvent[];
}

/**
 * Shared machinery for CLI tools driven as subprocesses. These are spawned
 * through a real PTY rather than plain pipes: several agent CLIs buffer or
 * refuse to run when stdout is not a TTY (Antigravity has a known hang in that
 * case), and a PTY also keeps their interactive prompts from deadlocking.
 */
export class PtyAgentHandle implements AgentHandle {
  readonly agentId: string;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly completion: Promise<AgentRunResult>;
  private pty: IPty | undefined;
  private buffer = "";
  private usage: TokenUsage | undefined;
  private disposed = false;

  constructor(
    options: AgentRunOptions,
    spec: PtySpawnSpec,
    private readonly config: PtyAdapterConfig,
  ) {
    this.agentId = options.agentId;
    this.completion = this.spawn(options, spec);
  }

  onEvent(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForCompletion(): Promise<AgentRunResult> {
    return this.completion;
  }

  async interrupt(): Promise<void> {
    this.pty?.write("\x03");
  }

  async kill(): Promise<void> {
    this.dispose();
  }

  /**
   * node-pty keeps the event loop alive until the handle is released, so every
   * exit path must dispose or the CLI hangs after the work is done.
   */
  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.pty?.kill();
    } catch {
      // already gone
    }
    this.pty = undefined;
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async spawn(options: AgentRunOptions, spec: PtySpawnSpec): Promise<AgentRunResult> {
    const { spawn } = await import("node-pty");

    if (this.config.rawLogPath) mkdirSync(dirname(this.config.rawLogPath), { recursive: true });

    try {
      this.pty = spawn(spec.command, spec.args, {
        name: "xterm-color",
        cols: 120,
        rows: 40,
        cwd: options.cwd,
        env: { ...process.env, ...spec.env } as Record<string, string>,
      });
    } catch (error) {
      const message = `failed to start ${spec.command}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.emit({ type: "error", agentId: this.agentId, message, fatal: true });
      return { ok: false, stalled: false, error: message };
    }

    this.emit({ type: "status", agentId: this.agentId, status: "running" });

    return new Promise<AgentRunResult>((resolve) => {
      this.pty?.onData((chunk) => {
        this.mirror(chunk);
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? "";
        for (const line of lines) this.handleLine(line);
      });

      this.pty?.onExit(({ exitCode }) => {
        if (this.buffer.trim()) this.handleLine(this.buffer);
        this.buffer = "";
        this.dispose();
        resolve({
          ok: exitCode === 0,
          stalled: false,
          ...(this.usage ? { usage: this.usage } : {}),
          ...(exitCode === 0 ? {} : { error: `exited with code ${exitCode}` }),
        });
      });
    });
  }

  private handleLine(line: string): void {
    const clean = stripAnsi(line).trim();
    if (!clean) return;
    for (const event of this.config.parseLine(clean, this.agentId)) {
      if (event.type === "usage") this.usage = event.usage;
      this.emit(event);
    }
  }

  private mirror(chunk: string): void {
    if (!this.config.rawLogPath) return;
    try {
      appendFileSync(this.config.rawLogPath, chunk, "utf8");
    } catch {
      // diagnostics must never take down a run
    }
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}

/** Convenience for adapters whose tools emit one JSON object per line. */
export function parseJsonLine(line: string): Record<string, unknown> | null {
  if (!line.startsWith("{")) return null;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}
