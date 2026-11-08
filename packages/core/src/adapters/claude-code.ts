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

/**
 * Claude Code runs in-process through the Agent SDK rather than as a wrapped
 * subprocess: it yields typed messages directly, so there is no stdout to parse
 * and no PTY to babysit. The other adapters have no SDK equivalent.
 */
export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code" as const;
  readonly displayName = "Claude Code";
  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    structuredOutput: true,
    resumable: true,
  };

  async check(): Promise<AdapterHealth> {
    const hasKey =
      Boolean(process.env["ANTHROPIC_API_KEY"]) || Boolean(process.env["CLAUDE_CODE_OAUTH_TOKEN"]);
    // The SDK also accepts credentials stored by `claude login`, so an env key
    // is sufficient but not necessary — the binary being present means auth may
    // already be set up, and only a real call could prove it either way.
    const cliOnPath = await hasClaudeCli();

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
    return new ClaudeCodeHandle(options);
  }
}

class ClaudeCodeHandle implements AgentHandle {
  readonly agentId: string;
  private readonly listeners = new Set<AgentEventListener>();
  private readonly abort = new AbortController();
  private readonly stream: Query;
  private readonly completion: Promise<AgentRunResult>;

  constructor(options: AgentRunOptions) {
    this.agentId = options.agentId;

    const sdkOptions: Options = {
      cwd: options.cwd,
      abortController: this.abort,
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
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "error", agentId: this.agentId, message, fatal: true });
      return { ok: false, stalled: false, error: message };
    }
  }
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
