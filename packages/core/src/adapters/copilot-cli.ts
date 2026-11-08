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

/**
 * Default tool allowlist. Copilot CLI denies or stalls on tool use in headless
 * runs unless permissions are granted explicitly, and a blanket --yolo would
 * hand an unattended agent every capability at once, so the profile is scoped
 * to what a coding worker actually needs.
 */
export const COPILOT_DEFAULT_ALLOWED_TOOLS = ["shell", "write", "edit", "read", "search"];

export interface CopilotAdapterOptions {
  allowedTools?: string[];
  rawLogPath?: (agentId: string) => string;
}

export class CopilotCliAdapter implements AgentAdapter {
  readonly id = "copilot-cli" as const;
  readonly displayName = "GitHub Copilot CLI";
  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    structuredOutput: true,
    resumable: false,
  };

  constructor(private readonly options: CopilotAdapterOptions = {}) {}

  async check(): Promise<AdapterHealth> {
    const installed = await commandExists("copilot");
    if (!installed) {
      return {
        installed: false,
        authenticated: false,
        detail: "`copilot` not on PATH — install with `npm i -g @github/copilot`",
      };
    }
    const authenticated = Boolean(
      process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"] ?? process.env["COPILOT_TOKEN"],
    );
    return {
      installed: true,
      authenticated,
      detail: authenticated
        ? "using token from env"
        : "no GITHUB_TOKEN/GH_TOKEN in env — run `copilot` once interactively to sign in",
    };
  }

  async start(options: AgentRunOptions): Promise<AgentHandle> {
    const allowed = this.options.allowedTools ?? COPILOT_DEFAULT_ALLOWED_TOOLS;
    const args = [
      "-p",
      options.prompt,
      "--output-format",
      "json",
      "--no-ask-user",
      ...allowed.flatMap((tool) => ["--allow-tool", tool]),
    ];
    if (options.model) args.push("--model", options.model);

    return new PtyAgentHandle(
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
 * Copilot's headless JSON shape is not fully specified in its docs, so anything
 * unrecognized is surfaced as plain text rather than dropped — losing agent
 * output would be worse than showing a raw line.
 */
export function parseCopilotLine(line: string, agentId: string): AgentEvent[] {
  const json = parseJsonLine(line);
  if (!json) return [{ type: "text", agentId, text: line }];

  const type = typeof json["type"] === "string" ? (json["type"] as string) : "";

  switch (type) {
    case "assistant":
    case "message":
    case "text": {
      const text = typeof json["text"] === "string" ? json["text"] : stringify(json["content"]);
      return text ? [{ type: "text", agentId, text }] : [];
    }
    case "tool_use":
    case "tool_call": {
      const toolName = typeof json["name"] === "string" ? json["name"] : "tool";
      return [{ type: "tool_call", agentId, toolName, input: json["input"] }];
    }
    case "error":
      return [
        { type: "error", agentId, message: stringify(json["message"] ?? json), fatal: false },
      ];
    case "result":
    case "workflow.result": {
      const events: AgentEvent[] = [];
      const usage = readUsage(json["usage"]);
      if (usage) events.push({ type: "usage", agentId, usage });
      events.push({
        type: "done",
        agentId,
        ok: json["is_error"] !== true && json["error"] === undefined,
        ...(usage ? { usage } : {}),
      });
      return events;
    }
    default:
      return [{ type: "text", agentId, text: line }];
  }
}

function readUsage(raw: unknown): { inputTokens: number; outputTokens: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const input = Number(usage["input_tokens"] ?? usage["prompt_tokens"] ?? 0);
  const output = Number(usage["output_tokens"] ?? usage["completion_tokens"] ?? 0);
  if (!input && !output) return undefined;
  return { inputTokens: input, outputTokens: output };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}
