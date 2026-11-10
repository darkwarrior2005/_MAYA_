import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent, TokenUsage } from "@maya/shared-types";
import type {
  AgentEventListener,
  AgentHandle,
  AgentRunOptions,
  AgentRunResult,
} from "./adapter.js";
import { resolveExecutable } from "./which.js";

/**
 * How the child's output is read.
 *
 * `pipe` is the default. A PTY renders output into a console screen buffer and
 * hard-wraps at the terminal width, which splits long JSON lines mid-token —
 * Copilot's usage checkpoint alone runs to several kilobytes — so structured
 * output arrives corrupted and unparseable. Pipes deliver it byte for byte.
 *
 * `pty` stays available for a tool that genuinely refuses to run without a
 * TTY, at the cost of that wrapping.
 */
export type Transport = "pipe" | "pty";

export interface SubprocessSpawnSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
  transport?: Transport;
}

export interface SubprocessAdapterConfig {
  /** Where to mirror raw output so a stall can be diagnosed after the fact. */
  rawLogPath?: string;
  /** Turns one parsed stdout line into normalized events. */
  parseLine: (line: string, agentId: string) => AgentEvent[];
}

interface ChildHandle {
  interrupt(): void;
  kill(): void;
}

export class SubprocessAgentHandle implements AgentHandle {
  readonly agentId: string;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly completion: Promise<AgentRunResult>;
  private child: ChildHandle | undefined;
  private exited = false;
  private warnedCorrupt = false;
  private buffer = "";
  private usage: TokenUsage | undefined;
  private disposed = false;
  /** Set when the parser saw the tool's own completion record. */
  private done: { ok: boolean; sessionId?: string } | undefined;
  private fatalError: string | undefined;

  constructor(
    options: AgentRunOptions,
    spec: SubprocessSpawnSpec,
    private readonly config: SubprocessAdapterConfig,
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
    this.child?.interrupt();
  }

  async kill(): Promise<void> {
    this.dispose();
  }

  /**
   * node-pty keeps the event loop alive until its handle is released, so every
   * exit path must dispose or the CLI hangs after the work is done.
   */
  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Killing a ConPTY that already exited makes node-pty fork a helper to
    // enumerate console processes; it fails with "AttachConsole failed" and
    // prints a stack trace over our output. Nothing needs killing once the
    // child is gone.
    if (!this.exited) {
      try {
        this.child?.kill();
      } catch {
        // already gone
      }
    }
    this.child = undefined;
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async spawn(
    options: AgentRunOptions,
    spec: SubprocessSpawnSpec,
  ): Promise<AgentRunResult> {
    if (this.config.rawLogPath) mkdirSync(dirname(this.config.rawLogPath), { recursive: true });

    // Neither node-pty nor a shell-less child_process spawn does PATH/PATHEXT
    // lookup, so a bare name that works in a shell fails with "File not found".
    const command = (await resolveExecutable(spec.command)) ?? spec.command;
    const env = { ...process.env, ...spec.env } as Record<string, string>;

    try {
      return spec.transport === "pty" && (await ptyAvailable())
        ? await this.runPty(command, spec, options, env)
        : await this.runPipe(command, spec, options, env);
    } catch (error) {
      const message = `failed to start ${spec.command}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      this.emit({ type: "error", agentId: this.agentId, message, fatal: true });
      return { ok: false, stalled: false, error: message };
    }
  }

  private async runPipe(
    command: string,
    spec: SubprocessSpawnSpec,
    options: AgentRunOptions,
    env: Record<string, string>,
  ): Promise<AgentRunResult> {
    const { spawn } = await import("node:child_process");
    // Node refuses to spawn a .cmd or .bat directly (CVE-2024-27980), and a
    // path with spaces needs quoting once a shell is involved. `agy` resolves
    // to agy.cmd on Windows, so this is the normal case, not an edge one.
    const viaShell = needsShell(command);
    const child = spawn(viaShell ? quoteForShell(command) : command, spec.args, {
      cwd: options.cwd,
      env,
      shell: viaShell,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child = {
      interrupt: () => child.kill("SIGINT"),
      kill: () => child.kill(),
    };

    this.emit({ type: "status", agentId: this.agentId, status: "running" });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding("utf8");
    // Diagnostics only — never parsed as events, but kept for the raw log.
    child.stderr.on("data", (chunk: string) => this.mirror(chunk));

    return new Promise<AgentRunResult>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        this.exited = true;
        resolve(this.finish(code ?? -1));
      });
    });
  }

  private async runPty(
    command: string,
    spec: SubprocessSpawnSpec,
    options: AgentRunOptions,
    env: Record<string, string>,
  ): Promise<AgentRunResult> {
    // node-pty is optional: it needs a native build and ships prebuilds only
    // for Windows and macOS, so requiring it would break `pnpm install` on a
    // Linux box without build tools. Nothing Maya does by default needs it —
    // the pipe transport is the default precisely because a console screen
    // buffer hard-wraps the long JSON lines these tools emit.
    const { spawn } = await importNodePty();
    const pty = spawn(command, spec.args, {
      name: "xterm-color",
      // Wide enough that the console buffer wraps as little as possible.
      cols: 4096,
      rows: 64,
      cwd: options.cwd,
      env,
    });

    this.child = { interrupt: () => pty.write("\x03"), kill: () => pty.kill() };
    this.emit({ type: "status", agentId: this.agentId, status: "running" });

    return new Promise<AgentRunResult>((resolve) => {
      pty.onData((chunk) => this.consume(chunk));
      pty.onExit(({ exitCode }) => {
        this.exited = true;
        resolve(this.finish(exitCode));
      });
    });
  }

  private consume(chunk: string): void {
    this.mirror(chunk);
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) this.handleLine(line);
  }

  private finish(exitCode: number): AgentRunResult {
    if (this.buffer.trim()) this.handleLine(this.buffer);
    this.buffer = "";
    this.dispose();
    // Exit status is not trustworthy on its own — Copilot CLI exits 0 even
    // when every tool call was denied and nothing was done — so the tool's
    // own completion record wins when the parser produced one. A fatal error
    // overrides both: Copilot reports a clean result after a denied tool, and
    // treating that as success would merge a branch where nothing happened.
    const reportedOk = this.done ? this.done.ok : exitCode === 0;
    const ok = reportedOk && this.fatalError === undefined;
    return {
      ok,
      stalled: false,
      ...(this.done?.sessionId ? { sessionId: this.done.sessionId } : {}),
      ...(this.usage ? { usage: this.usage } : {}),
      ...(ok ? {} : { error: this.failureReason(exitCode) }),
    };
  }

  private handleLine(line: string): void {
    const clean = stripAnsi(line).trim();
    if (!clean) return;

    // A line that opens like JSON and does not parse is a chopped stream, not
    // chatter. That is exactly how the PTY bug hid itself: every line was
    // dropped in silence and the run looked clean. Said once per run, because
    // a broken stream breaks every line.
    if (!this.warnedCorrupt && looksLikeTruncatedJson(clean)) {
      this.warnedCorrupt = true;
      this.emit({
        type: "error",
        agentId: this.agentId,
        message:
          "the tool's output stream looks corrupted: a line began as JSON and " +
          "could not be parsed. Its raw output is in .maya/logs.",
        fatal: false,
      });
    }

    for (const event of this.config.parseLine(clean, this.agentId)) {
      if (event.type === "usage") this.usage = event.usage;
      if (event.type === "error" && event.fatal) this.fatalError = event.message;
      if (event.type === "done") {
        this.done = {
          ok: event.ok,
          ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        };
        if (event.usage) this.usage = event.usage;
      }
      this.emit(event);
    }
  }

  private failureReason(exitCode: number): string {
    if (this.fatalError) return this.fatalError;
    return this.done ? "the agent reported failure" : `exited with code ${exitCode}`;
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

/** Whether the optional native module is actually installed. */
async function ptyAvailable(): Promise<boolean> {
  try {
    await import("node-pty");
    return true;
  } catch {
    return false;
  }
}

/**
 * A line that starts like JSON but will not parse. Pipes should never produce
 * one; a PTY chopping long lines produces nothing else.
 */
function looksLikeTruncatedJson(line: string): boolean {
  if (!line.startsWith("{") && !line.startsWith("[")) return false;
  try {
    JSON.parse(line);
    return false;
  } catch {
    return true;
  }
}

/** True for a Windows batch script, which cannot be spawned directly. */
function needsShell(command: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(command);
}

/** cmd.exe splits on spaces unless the program is quoted. */
function quoteForShell(command: string): string {
  return command.includes(" ") ? `"${command}"` : command;
}

type NodePtyModule = typeof import("node-pty");

async function importNodePty(): Promise<NodePtyModule> {
  try {
    return await import("node-pty");
  } catch (cause) {
    throw new Error(
      'the "pty" transport needs the optional node-pty package, which is not installed ' +
        "(it has no prebuilt binary for this platform and needs a C++ toolchain to build). " +
        'Use the default "pipe" transport, or install node-pty yourself.',
      { cause },
    );
  }
}
