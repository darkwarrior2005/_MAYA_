import type { AgentEvent, TokenUsage } from "@maya/shared-types";
import type {
  AdapterCapabilities,
  AdapterHealth,
  AgentAdapter,
  AgentHandle,
  AgentRunOptions,
} from "./adapter.js";
import { SubprocessAgentHandle, parseJsonLine } from "./subprocess-adapter.js";
import { resolveExecutable } from "./which.js";

/**
 * Permission patterns, not tool names. Copilot's rules take the form
 * `kind(argument)` — `write(path?)`, `shell(command:*?)` — so passing an
 * internal tool name like `apply_patch` silently grants nothing and every
 * tool call is denied. Only writes are granted by default: a worker needs to
 * edit files, while shell access is left for a project to opt into.
 */
export const COPILOT_DEFAULT_ALLOWED_TOOLS = ["write"];

/**
 * The permission kinds Copilot understands. A pattern is `kind` or
 * `kind(argument)`; anything else grants nothing.
 */
const COPILOT_PERMISSION_KINDS = new Set(["write", "shell", "read", "fetch", "mcp"]);

/**
 * Says what is wrong with a permission pattern, or null if it is fine.
 *
 * Checked before launching, because Copilot does not complain: a pattern it
 * does not understand silently grants nothing, every tool call is denied, the
 * run does nothing — and it still costs one premium request. Failing here
 * costs nothing and says which pattern to fix.
 */
export function describeBadPermission(pattern: string): string | null {
  const match = /^([a-z_]+)(?:\((.*)\))?$/i.exec(pattern.trim());
  if (!match) {
    return `"${pattern}" is not a permission pattern — expected kind or kind(argument), such as write or shell(git:*)`;
  }
  const kind = (match[1] ?? "").toLowerCase();
  if (!COPILOT_PERMISSION_KINDS.has(kind)) {
    return `"${pattern}" names "${kind}", which is not a Copilot permission kind (${[...COPILOT_PERMISSION_KINDS].join(", ")}). Internal tool names like apply_patch grant nothing.`;
  }
  return null;
}

export interface CopilotAdapterOptions {
  /** Permission patterns passed to --allow-tool. */
  allowedTools?: string[];
  /** Patterns passed to --deny-tool; denials always beat allows. */
  deniedTools?: string[];
  rawLogPath?: (agentId: string) => string;
}

export class CopilotCliAdapter implements AgentAdapter {
  readonly id = "copilot-cli" as const;
  readonly displayName = "GitHub Copilot CLI";
  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    structuredOutput: true,
    resumable: true,
  };

  constructor(private readonly options: CopilotAdapterOptions = {}) {}

  async check(): Promise<AdapterHealth> {
    const resolvedPath = await resolveExecutable("copilot");
    if (!resolvedPath) {
      return {
        installed: false,
        authenticated: false,
        detail: "`copilot` not on PATH — install with `npm i -g @github/copilot`",
      };
    }
    const hasToken = Boolean(
      process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? process.env["COPILOT_TOKEN"],
    );
    return {
      installed: true,
      authenticated: true,
      resolvedPath,
      // A token in the environment is a fact; a stored login is a hope.
      verified: hasToken,
      detail: hasToken
        ? "using token from env"
        : "assumes credentials from a prior `copilot login` (not verified)",
    };
  }

  async start(options: AgentRunOptions): Promise<AgentHandle> {
    // The worker profile wins over the adapter default, so one worker can be
    // allowed to run commands while another is limited to edits.
    const allowed =
      options.allowedTools ?? this.options.allowedTools ?? COPILOT_DEFAULT_ALLOWED_TOOLS;
    const denied = options.deniedTools ?? this.options.deniedTools ?? [];
    const bad = [...allowed, ...denied]
      .map((pattern) => describeBadPermission(pattern))
      .filter((problem): problem is string => problem !== null);
    if (bad.length > 0) {
      throw new Error(
        `refusing to start Copilot: ${bad.join("; ")}. ` +
          "A pattern Copilot cannot read grants nothing, denies every tool call, " +
          "and still costs a premium request.",
      );
    }

    const args = [
      "-p",
      options.prompt,
      "--output-format",
      "json",
      "--no-ask-user",
      ...allowed.flatMap((pattern) => ["--allow-tool", pattern]),
      ...denied.flatMap((pattern) => ["--deny-tool", pattern]),
    ];
    if (options.model) args.push("--model", options.model);
    if (options.resumeSessionId) args.push("--session-id", options.resumeSessionId);

    return new SubprocessAgentHandle(
      options,
      { command: "copilot", args },
      {
        parseLine: parseCopilotLine,
        ...(this.options.rawLogPath ? { rawLogPath: this.options.rawLogPath(options.agentId) } : {}),
      },
    );
  }
}

/**
 * Copilot emits a chatty JSONL stream — streaming deltas, MCP chatter and a
 * multi-kilobyte usage checkpoint. Only the settled records are surfaced;
 * echoing unknown lines as chat text would bury the actual answer, and the raw
 * stream is mirrored to .maya/logs anyway for diagnosis.
 */
export function parseCopilotLine(line: string, agentId: string): AgentEvent[] {
  const json = parseJsonLine(line);
  if (!json) return [];
  if (json["ephemeral"] === true) return [];

  const type = typeof json["type"] === "string" ? (json["type"] as string) : "";
  const data = (json["data"] ?? {}) as Record<string, unknown>;

  switch (type) {
    case "assistant.message": {
      const content = typeof data["content"] === "string" ? data["content"] : "";
      return content.trim() ? [{ type: "text", agentId, text: content }] : [];
    }

    case "tool.execution_start": {
      const toolName = typeof data["toolName"] === "string" ? data["toolName"] : "tool";
      return [{ type: "tool_call", agentId, toolName, input: data["arguments"] }];
    }

    case "tool.execution_complete": {
      const toolName = typeof data["toolName"] === "string" ? data["toolName"] : "tool";
      const ok = data["success"] === true;
      const events: AgentEvent[] = [
        { type: "tool_result", agentId, toolName, ok, output: data["result"] },
      ];
      const error = data["error"] as { code?: string; message?: string } | undefined;
      if (!ok && error?.code === "denied") {
        // Unattended runs cannot answer a prompt, so a denial is terminal and
        // means the permission patterns are wrong — not a step the agent can
        // retry its way out of.
        events.push({
          type: "error",
          agentId,
          message: `permission denied for ${toolName}: ${
            error.message ?? "no allow rule matched"
          }. Grant it with an --allow-tool pattern such as write(...) or shell(...).`,
          fatal: true,
        });
      }
      return events;
    }

    case "session.usage_checkpoint": {
      const usage = readCheckpointUsage(data);
      return usage ? [{ type: "usage", agentId, usage }] : [];
    }

    case "result": {
      // exitCode is 0 even when every tool was denied, so a fatal error
      // recorded earlier in the stream is what actually decides the outcome.
      const exitCode = typeof json["exitCode"] === "number" ? json["exitCode"] : 0;
      const sessionId = typeof json["sessionId"] === "string" ? json["sessionId"] : undefined;
      return [
        {
          type: "done",
          agentId,
          ok: exitCode === 0,
          ...(sessionId ? { sessionId } : {}),
        },
      ];
    }

    default:
      return [];
  }
}

function readCheckpointUsage(data: Record<string, unknown>): TokenUsage | undefined {
  const snapshot = data["accountingSnapshot"] as Record<string, unknown> | undefined;
  const details = snapshot?.["tokenDetails"] as Record<string, { tokenCount?: number }> | undefined;
  if (!details) return undefined;

  const usage: TokenUsage = {
    inputTokens: details["input"]?.tokenCount ?? 0,
    outputTokens: details["output"]?.tokenCount ?? 0,
  };
  const cacheRead = details["cache_read"]?.tokenCount;
  const cacheWrite = details["cache_write"]?.tokenCount;
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  return usage;
}
