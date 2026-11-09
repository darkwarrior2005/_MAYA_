import type { AgentEvent, TokenUsage } from "@maya/shared-types";
import type {
  AdapterCapabilities,
  AdapterHealth,
  AgentAdapter,
  AgentHandle,
  AgentRunOptions,
} from "./adapter.js";
import { SubprocessAgentHandle, parseJsonLine } from "./subprocess-adapter.js";
import { commandExists } from "./which.js";

export type AntigravityMode = "accept-edits" | "auto" | "plan";

export interface AntigravityAdapterOptions {
  /**
   * `accept-edits` lets a worker write files without a prompt nobody can
   * answer, while stopping short of `--dangerously-skip-permissions`, which
   * would also auto-approve shell commands.
   */
  mode?: AntigravityMode;
  /** Opt in to --dangerously-skip-permissions. Off by default. */
  skipPermissions?: boolean;
  rawLogPath?: (agentId: string) => string;
}

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
    const args = ["--output-format", "stream-json", "--mode", this.options.mode ?? "accept-edits"];
    if (options.model) args.push("--model", options.model);
    if (options.resumeSessionId) args.push("--conversation", options.resumeSessionId);
    if (this.options.skipPermissions) args.push("--dangerously-skip-permissions");
    args.push("-p", options.prompt);

    return new SubprocessAgentHandle(
      options,
      { command: "agy", args },
      {
        parseLine: makeAntigravityParser(),
        ...(this.options.rawLogPath ? { rawLogPath: this.options.rawLogPath(options.agentId) } : {}),
      },
    );
  }
}

/**
 * Antigravity streams assistant text as many small `text_delta` chunks. They
 * are joined per step and emitted once the step settles, so the chat log gets
 * whole replies rather than a message per token.
 */
export function makeAntigravityParser(): (line: string, agentId: string) => AgentEvent[] {
  const pending = new Map<number, string>();

  return (line, agentId) => {
    const json = parseJsonLine(line);
    if (!json) return [];

    const event = typeof json["event"] === "string" ? (json["event"] as string) : "";

    if (event === "init") {
      const init = (json["init"] ?? {}) as Record<string, unknown>;
      const model = typeof init["model"] === "string" ? init["model"] : undefined;
      return [
        {
          type: "status",
          agentId,
          status: "running",
          ...(model ? { detail: `model ${model}` } : {}),
        },
      ];
    }

    if (event === "step_update") {
      const step = (json["step_update"] ?? {}) as Record<string, unknown>;
      const stepType = typeof step["step_type"] === "string" ? step["step_type"] : "";
      const state = typeof step["state"] === "string" ? step["state"] : "";
      const index = typeof step["step_index"] === "number" ? step["step_index"] : -1;

      if (stepType === "agent_response") {
        const delta = typeof step["text_delta"] === "string" ? step["text_delta"] : "";
        pending.set(index, (pending.get(index) ?? "") + delta);
        if (state !== "DONE") return [];
        const text = (pending.get(index) ?? "").trim();
        pending.delete(index);
        return text ? [{ type: "text", agentId, text }] : [];
      }

      if (stepType === "tool") {
        const toolName = typeof step["tool_name"] === "string" ? step["tool_name"] : "tool";
        const info = (step["tool_info"] ?? {}) as Record<string, unknown>;
        if (state === "ACTIVE") {
          return [{ type: "tool_call", agentId, toolName, input: info["parameters"] }];
        }
        // A successful step carries no status field at all, so success is
        // inferred from reaching DONE without an error rather than assumed —
        // no failing sample was available to confirm the error shape.
        const error = step["error"] ?? info["error"];
        const ok = state === "DONE" && !error;
        return [
          {
            type: "tool_result",
            agentId,
            toolName,
            ok,
            output: error ?? info["result"],
          },
        ];
      }

      return [];
    }

    if (event === "result") {
      const result = (json["result"] ?? {}) as Record<string, unknown>;
      const status = typeof result["status"] === "string" ? result["status"] : "";
      const usage = readUsage(result["usage"]);
      const conversationId =
        typeof result["conversation_id"] === "string" ? result["conversation_id"] : undefined;

      const events: AgentEvent[] = [];
      if (usage) events.push({ type: "usage", agentId, usage });
      if (status !== "SUCCESS") {
        events.push({
          type: "error",
          agentId,
          message: `run finished with status ${status || "unknown"}`,
          fatal: true,
        });
      }
      events.push({
        type: "done",
        agentId,
        ok: status === "SUCCESS",
        ...(conversationId ? { sessionId: conversationId } : {}),
        ...(usage ? { usage } : {}),
      });
      return events;
    }

    return [];
  };
}

function readUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const input = Number(usage["input_tokens"] ?? 0);
  const output = Number(usage["output_tokens"] ?? 0);
  if (!input && !output) return undefined;
  const cacheRead = usage["cache_read_tokens"];
  return {
    inputTokens: input,
    outputTokens: output,
    ...(typeof cacheRead === "number" ? { cacheReadTokens: cacheRead } : {}),
  };
}
