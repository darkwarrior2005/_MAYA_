import type { AgentEvent } from "@maya/shared-types";
import type {
  AdapterCapabilities,
  AdapterHealth,
  AgentAdapter,
  AgentHandle,
  AgentRunOptions,
} from "./adapter.js";
import { PtyAgentHandle, parseJsonLine } from "./pty-adapter.js";
import { commandExists } from "./which.js";

export interface AntigravityAdapterOptions {
  /** Allow the agent to act without per-action approval. Off by default. */
  skipPermissions?: boolean;
  rawLogPath?: (agentId: string) => string;
}

/**
 * Antigravity's CLI (`agy`) is the newest of the three and the least settled:
 * it has a reported hang when stdout is not a TTY, which the PTY spawn is meant
 * to avoid, and its usage field names in plain -p mode are unconfirmed. Treat
 * parsing here as best-effort and lean on the raw log when it misbehaves.
 */
export class AntigravityCliAdapter implements AgentAdapter {
  readonly id = "antigravity-cli" as const;
  readonly displayName = "Google Antigravity CLI";
  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    structuredOutput: true,
    resumable: true,
  };

  constructor(private readonly options: AntigravityAdapterOptions = {}) {}

  async check(): Promise<AdapterHealth> {
    const installed = await commandExists("agy");
    if (!installed) {
      return {
        installed: false,
        authenticated: false,
        detail: "`agy` not on PATH — install from antigravity.google/cli (not via npm)",
      };
    }
    return {
      installed: true,
      authenticated: true,
      detail: "assumes cached credentials from a prior interactive `agy` login (not verified)",
    };
  }

  async start(options: AgentRunOptions): Promise<AgentHandle> {
    const args = ["-p", options.prompt, "--output-format", "stream-json"];
    if (options.model) args.push("--model", options.model);
    if (options.resumeSessionId) args.push("--conversation", options.resumeSessionId);
    if (this.options.skipPermissions) args.push("--dangerously-skip-permissions");

    return new PtyAgentHandle(
      options,
      { command: "agy", args },
      {
        parseLine: parseAntigravityLine,
        ...(this.options.rawLogPath ? { rawLogPath: this.options.rawLogPath(options.agentId) } : {}),
      },
    );
  }
}

export function parseAntigravityLine(line: string, agentId: string): AgentEvent[] {
  const json = parseJsonLine(line);
  if (!json) return [{ type: "text", agentId, text: line }];

  const type = typeof json["type"] === "string" ? (json["type"] as string) : "";

  switch (type) {
    case "assistant":
    case "message": {
      const text = extractText(json);
      return text ? [{ type: "text", agentId, text }] : [];
    }
    case "tool_use": {
      const toolName = typeof json["name"] === "string" ? json["name"] : "tool";
      return [{ type: "tool_call", agentId, toolName, input: json["input"] }];
    }
    case "error":
      return [{ type: "error", agentId, message: extractText(json) || line, fatal: false }];
    case "result": {
      const events: AgentEvent[] = [];
      const usage = readUsage(json["usage"]);
      if (usage) events.push({ type: "usage", agentId, usage });
      events.push({
        type: "done",
        agentId,
        ok: json["is_error"] !== true,
        ...(typeof json["conversation_id"] === "string"
          ? { sessionId: json["conversation_id"] }
          : {}),
        ...(usage ? { usage } : {}),
      });
      return events;
    }
    default:
      return [{ type: "text", agentId, text: line }];
  }
}

function extractText(json: Record<string, unknown>): string {
  if (typeof json["text"] === "string") return json["text"];
  const message = json["message"];
  if (typeof message === "string") return message;
  if (message && typeof message === "object") {
    const content = (message as Record<string, unknown>)["content"];
    if (Array.isArray(content)) {
      return content
        .map((block) =>
          block && typeof block === "object" && typeof (block as { text?: string }).text === "string"
            ? (block as { text: string }).text
            : "",
        )
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

function readUsage(raw: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const input = Number(usage["input_tokens"] ?? usage["prompt_tokens"] ?? 0);
  const output = Number(usage["output_tokens"] ?? usage["completion_tokens"] ?? 0);
  if (!input && !output) return undefined;
  return { inputTokens: input, outputTokens: output };
}
