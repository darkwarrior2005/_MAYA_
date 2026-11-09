import { query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, TokenUsage } from "@maya/shared-types";
import type {
  AdapterCapabilities,
  AdapterHealth,
  AgentAdapter,
  AgentEventListener,
  AgentHandle,
  AgentRunOptions,
  AgentRunResult,
} from "./adapter.js";
import { findGitBash } from "./git-bash.js";

/**
 * Claude Code runs in-process through the Agent SDK rather than as a wrapped
 * subprocess: it yields typed messages directly, so there is no stdout to parse
 * and no PTY to babysit. The other adapters have no SDK equivalent.
 */
export interface ClaudeCodeAdapterOptions {
  /**
   * Workers run unattended, so file edits are auto-accepted by default —
   * 'default' would stall waiting for a prompt nobody can answer. Note this is
   * deliberately *not* 'bypassPermissions', which would also wave through
   * commands the agent was never meant to run.
   */
  permissionMode?: "default" | "acceptEdits" | "plan" | "dontAsk";
  /** Hard stop so a confused agent cannot loop indefinitely. */
  maxTurns?: number;
  maxBudgetUsd?: number;
  /**
   * Path to an installed `claude` binary. Maya drives the CLIs a machine
   * already has rather than carrying the SDK's ~160MB bundled copy, so this
   * resolves from PATH by default.
   */
  claudeExecutable?: string;
}

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code" as const;
  readonly displayName = "Claude Code";
  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    structuredOutput: true,
    resumable: true,
  };

  constructor(private readonly options: ClaudeCodeAdapterOptions = {}) {}

  async check(): Promise<AdapterHealth> {
    const hasKey =
      Boolean(process.env["ANTHROPIC_API_KEY"]) || Boolean(process.env["CLAUDE_CODE_OAUTH_TOKEN"]);
    // The SDK also accepts credentials stored by `claude login`, so an env key
    // is sufficient but not necessary — the binary being present means auth may
    // already be set up, and only a real call could prove it either way.
    const cliOnPath = await hasClaudeCli();

    if (process.platform === "win32" && !(await findGitBash())) {
      return {
        installed: true,
        authenticated: false,
        detail:
          "git-bash not found — Claude Code needs it on Windows; install Git for Windows or set CLAUDE_CODE_GIT_BASH_PATH",
      };
    }

    if (hasKey) return { installed: true, authenticated: true, detail: "using API key from env" };
    if (cliOnPath) {
      return {
        installed: true,
        authenticated: true,
        detail: "relying on credentials stored by `claude login` (not verified)",
      };
    }
    return {
      installed: true,
      authenticated: false,
      detail: "no API key in env and no `claude` CLI on PATH; run `claude login` or set a key",
    };
  }

  async start(options: AgentRunOptions): Promise<AgentHandle> {
    // Set before the SDK spawns the CLI; on Windows it exits immediately
    // without this and only explains why on stderr.
    if (!process.env["CLAUDE_CODE_GIT_BASH_PATH"]) {
      const bash = await findGitBash();
      if (bash) process.env["CLAUDE_CODE_GIT_BASH_PATH"] = bash;
    }

    const executable = this.options.claudeExecutable ?? (await resolveClaudePath());
    return new ClaudeCodeHandle(options, this.options, executable);
  }
}

class ClaudeCodeHandle implements AgentHandle {
  readonly agentId: string;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly abort = new AbortController();
  private readonly stderr: string[] = [];
  private readonly stream: Query;
  private readonly completion: Promise<AgentRunResult>;

  constructor(
    options: AgentRunOptions,
    adapterOptions: ClaudeCodeAdapterOptions,
    executable: string | null,
  ) {
    this.agentId = options.agentId;

    const sdkOptions: Options = {
      cwd: options.cwd,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      abortController: this.abort,
      // Without this the CLI's own diagnostics are lost and a failed start
      // reads only as "exited with code 1".
      stderr: (data: string) => {
        this.stderr.push(data);
      },
      permissionMode: adapterOptions.permissionMode ?? "acceptEdits",
      // The worker profile wins over the adapter default, so one worker can
      // be given a tighter budget than another.
      ...budget("maxTurns", options.maxTurns, adapterOptions.maxTurns),
      ...budget("maxBudgetUsd", options.maxBudgetUsd, adapterOptions.maxBudgetUsd),
      ...(options.model ? { model: options.model } : {}),
      ...(options.resumeSessionId ? { resume: options.resumeSessionId } : {}),
    } as Options;

    this.stream = query({ prompt: options.prompt, options: sdkOptions });
    this.completion = this.consume();
  }

  onEvent(listener: AgentEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  waitForCompletion(): Promise<AgentRunResult> {
    return this.completion;
  }

  async interrupt(): Promise<void> {
    await this.stream.interrupt();
  }

  async kill(): Promise<void> {
    this.abort.abort();
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private async consume(): Promise<AgentRunResult> {
    let sessionId: string | undefined;
    let usage: TokenUsage | undefined;

    try {
      this.emit({ type: "status", agentId: this.agentId, status: "starting" });

      for await (const message of this.stream) {
        for (const event of translate(message, this.agentId)) {
          if (event.type === "done") {
            sessionId = event.sessionId ?? sessionId;
            usage = event.usage ?? usage;
          }
          this.emit(event);
        }
        if (message.type === "system" && message.subtype === "init") {
          sessionId = message.session_id;
        }
        if (message.type === "result") {
          return {
            ok: !message.is_error,
            stalled: false,
            ...(message.session_id ? { sessionId: message.session_id } : {}),
            ...(usage ? { usage } : {}),
            ...(message.is_error ? { error: resultError(message) } : {}),
          };
        }
      }

      return {
        ok: false,
        stalled: false,
        ...(sessionId ? { sessionId } : {}),
        ...(usage ? { usage } : {}),
        error: "stream ended without a result message",
      };
    } catch (error) {
      const base = error instanceof Error ? error.message : String(error);
      const detail = this.stderr.join("").trim();
      const message = detail ? `${base}: ${detail}` : base;
      this.emit({ type: "error", agentId: this.agentId, message, fatal: true });
      return { ok: false, stalled: false, error: message };
    }
  }
}

/** Full path to the installed `claude`, or null to let the SDK pick. */
async function resolveClaudePath(): Promise<string | null> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const probe = spawn(process.platform === "win32" ? "where" : "which", ["claude"], {
      shell: false,
    });
    let output = "";
    probe.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    probe.on("error", () => resolve(null));
    probe.on("close", (code) => {
      if (code !== 0) return resolve(null);
      // Prefer a real executable over a shell shim on Windows.
      const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const exe = lines.find((l) => l.toLowerCase().endsWith(".exe")) ?? lines[0];
      resolve(exe ?? null);
    });
  });
}

async function hasClaudeCli(): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const probe = spawn(process.platform === "win32" ? "where" : "which", ["claude"], {
      stdio: "ignore",
      shell: false,
    });
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0));
  });
}

function resultError(message: Extract<SDKMessage, { type: "result" }>): string {
  if ("errors" in message && Array.isArray(message.errors) && message.errors.length > 0) {
    return message.errors.join("; ");
  }
  // A failed run can still carry subtype 'success' with the real message in
  // `result` (an API error, say), so reporting the subtype alone prints
  // "success" for something that plainly failed.
  if ("result" in message && typeof message.result === "string" && message.result.trim()) {
    return message.result;
  }
  return message.subtype;
}

/** Maps the SDK's message union onto Maya's normalized event union. */
function translate(message: SDKMessage, agentId: string): AgentEvent[] {
  switch (message.type) {
    case "assistant": {
      const events: AgentEvent[] = [];
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          events.push({ type: "text", agentId, text: block.text });
        } else if (block.type === "tool_use") {
          events.push({ type: "tool_call", agentId, toolName: block.name, input: block.input });
        }
      }
      return events;
    }
    case "system":
      return message.subtype === "init"
        ? [{ type: "status", agentId, status: "running", detail: `model ${message.model}` }]
        : [];
    case "result": {
      const usage = toTokenUsage(message);
      return [
        {
          type: "usage",
          agentId,
          usage,
        },
        {
          type: "done",
          agentId,
          ok: !message.is_error,
          sessionId: message.session_id,
          usage,
        },
      ];
    }
    default:
      return [];
  }
}

function toTokenUsage(message: Extract<SDKMessage, { type: "result" }>): TokenUsage {
  const usage = message.usage as {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    ...(usage.cache_read_input_tokens !== undefined
      ? { cacheReadTokens: usage.cache_read_input_tokens }
      : {}),
    ...(usage.cache_creation_input_tokens !== undefined
      ? { cacheWriteTokens: usage.cache_creation_input_tokens }
      : {}),
    costUsd: message.total_cost_usd,
  };
}

/** First defined wins, and an unset budget is left off entirely. */
function budget(
  key: "maxTurns" | "maxBudgetUsd",
  fromProfile: number | undefined,
  fromAdapter: number | undefined,
): Record<string, number> {
  const value = fromProfile ?? fromAdapter;
  return value === undefined ? {} : { [key]: value };
}
