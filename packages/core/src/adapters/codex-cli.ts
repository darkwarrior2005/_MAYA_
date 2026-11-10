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

/**
 * How much the sandbox lets a model-generated command do.
 *
 * Codex expresses permission as a sandbox policy rather than a list of
 * allowed tools, which is why a Copilot-style `allowedTools` on a Codex
 * worker is refused rather than quietly ignored — see `start`.
 *
 * `read-only` is Codex's own default for `exec`, and a worker that cannot
 * write is a worker that cannot do a task, so Maya asks for
 * `workspace-write`: edits inside the workspace, nothing outside it. That is
 * the same posture as `acceptEdits` for Claude Code and `write` for Copilot,
 * and it is not a bypass — `danger-full-access` is, and nothing here reaches
 * for it by default.
 */
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexAdapterOptions {
  sandbox?: CodexSandbox;
  /**
   * Opt in to `--dangerously-bypass-approvals-and-sandbox`. Off by default,
   * and deliberately awkward to reach: it turns off the sandbox as well as
   * the approvals, which is the one thing the invariant in CLAUDE.md forbids
   * Maya from doing on anyone's behalf.
   */
  dangerouslyBypassSandbox?: boolean;
  rawLogPath?: (agentId: string) => string;
}

/**
 * OpenAI Codex, driven through `codex exec --json`.
 *
 * `codex exec` is the documented non-interactive entry point: it streams
 * newline-delimited JSON events on stdout, one per state change, and takes a
 * session id to resume. That is the same shape Copilot and Antigravity are
 * driven in, so it reuses `SubprocessAgentHandle` — including the pipe
 * transport, because a PTY corrupts long JSON lines and the corruption looks
 * like success.
 *
 * The event names and payloads here come from OpenAI's own non-interactive
 * documentation, which publishes a worked sample of the stream. They have not
 * been checked against a running binary on this machine — `codex` was not
 * installed when this was written — so the parser treats every field as
 * optional and infers nothing it was not given. `docs/FINDINGS.md` has what
 * assuming a shape cost with Antigravity.
 */
export class CodexCliAdapter implements AgentAdapter {
  readonly id = "codex-cli" as const;
  readonly displayName = "OpenAI Codex CLI";
  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    structuredOutput: true,
    resumable: true,
  };

  constructor(private readonly options: CodexAdapterOptions = {}) {}

  async check(): Promise<AdapterHealth> {
    const installed = await commandExists("codex");
    if (!installed) {
      return {
        installed: false,
        authenticated: false,
        detail: "`codex` not on PATH — install with `npm install -g @openai/codex`, then `codex login`",
      };
    }

    // A key in the environment is a fact. A stored login is a hope: Codex has
    // no cheap way to say whether its credentials are still good, and only a
    // real call settles it — which is what the live probe is for.
    const key = process.env["CODEX_API_KEY"] ?? process.env["OPENAI_API_KEY"];
    if (key) {
      return {
        installed: true,
        authenticated: true,
        verified: true,
        detail: `using ${process.env["CODEX_API_KEY"] ? "CODEX_API_KEY" : "OPENAI_API_KEY"} from env`,
      };
    }
    return {
      installed: true,
      authenticated: true,
      verified: false,
      detail: "relying on credentials stored by `codex login` (not verified)",
    };
  }

  async start(options: AgentRunOptions): Promise<AgentHandle> {
    // Codex has no per-tool permission list, so a worker profile carrying one
    // has been copied from a Copilot worker and means something different
    // here. Refusing before the spawn is the point: silently dropping a
    // permission setting would run the agent with more freedom than whoever
    // wrote the profile believed they had granted.
    const listed = [...(options.allowedTools ?? []), ...(options.deniedTools ?? [])];
    if (listed.length > 0) {
      throw new Error(
        "codex-cli takes a sandbox policy, not a tool list: " +
          `remove allowedTools/deniedTools (${listed.join(", ")}) from this worker and set ` +
          '`"sandbox": "read-only" | "workspace-write"` instead.',
      );
    }

    return new SubprocessAgentHandle(
      options,
      { command: "codex", args: buildCodexArgs(options, this.options) },
      {
        parseLine: makeCodexParser(),
        ...(this.options.rawLogPath ? { rawLogPath: this.options.rawLogPath(options.agentId) } : {}),
      },
    );
  }
}

/**
 * The argv for one run. Pure, so what Maya actually asks Codex to do can be
 * asserted without spawning anything.
 */
export function buildCodexArgs(
  options: AgentRunOptions,
  adapter: CodexAdapterOptions = {},
): string[] {
  const args = ["exec", "--json"];

  // Never let the stream carry escape sequences. Agent text is untrusted for
  // rendering anyway, but a colourless stream is one less thing to strip.
  args.push("--color", "never");

  if (adapter.dangerouslyBypassSandbox) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", adapter.sandbox ?? "workspace-write");
  }

  if (options.model) args.push("--model", options.model);

  // `--json` and `--sandbox` belong to `exec`, so they go between `exec` and
  // the `resume` subcommand: put after `resume` they would be read as that
  // subcommand's flags, which it does not have.
  if (options.resumeSessionId) args.push("resume", options.resumeSessionId);

  // `--` first, because a prompt is arbitrary text: one that begins with a
  // dash would otherwise be parsed as a flag, and a prompt of exactly "-"
  // means "read the prompt from stdin", which would hang waiting on a stdin
  // nobody is going to write to.
  args.push("--", options.prompt);
  return args;
}

/**
 * The documented stream, which looks like this:
 *
 *   {"type":"thread.started","thread_id":"0199a213-..."}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_1","type":"command_execution",...}}
 *   {"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":24763,...}}
 *
 * `turn.failed` and `error` are documented alongside those but not sampled,
 * so both are read defensively: anything that is not an explicit success is
 * not treated as one, which is the invariant that a tool's reported success is
 * not success.
 */
export function makeCodexParser(): (line: string, agentId: string) => AgentEvent[] {
  let threadId: string | undefined;
  // Which items have already been announced as a tool call, so an item that
  // arrives only as `item.completed` — the docs say file_change and
  // web_search do — still produces a call before its result.
  const announced = new Set<string>();
  let failure: string | undefined;

  return (line, agentId) => {
    const json = parseJsonLine(line);
    if (!json) return [];

    const type = typeof json["type"] === "string" ? (json["type"] as string) : "";

    if (type === "thread.started") {
      const id = json["thread_id"];
      if (typeof id === "string") threadId = id;
      return [{ type: "status", agentId, status: "running" }];
    }

    if (type === "turn.started") return [];

    if (type === "item.started" || type === "item.updated" || type === "item.completed") {
      return itemEvents(json, agentId, type === "item.completed", announced);
    }

    if (type === "turn.completed") {
      const usage = readUsage(json["usage"]);
      const events: AgentEvent[] = [];
      if (usage) events.push({ type: "usage", agentId, usage });
      events.push({
        type: "done",
        agentId,
        // A turn that completed after a fatal error is not a success. The
        // handle records the error independently, but saying so here keeps
        // the done event honest on its own.
        ok: failure === undefined,
        ...(threadId ? { sessionId: threadId } : {}),
        ...(usage ? { usage } : {}),
      });
      return events;
    }

    if (type === "turn.failed") {
      const message = describeFailure(json["error"]) ?? "the turn failed";
      failure = message;
      const usage = readUsage(json["usage"]);
      const events: AgentEvent[] = [];
      if (usage) events.push({ type: "usage", agentId, usage });
      events.push({ type: "error", agentId, message, fatal: true });
      events.push({
        type: "done",
        agentId,
        ok: false,
        ...(threadId ? { sessionId: threadId } : {}),
        ...(usage ? { usage } : {}),
      });
      return events;
    }

    if (type === "error") {
      const message = describeFailure(json["error"] ?? json["message"]) ?? "codex reported an error";
      failure = message;
      return [{ type: "error", agentId, message, fatal: true }];
    }

    return [];
  };
}

function itemEvents(
  json: Record<string, unknown>,
  agentId: string,
  completed: boolean,
  announced: Set<string>,
): AgentEvent[] {
  const item = (json["item"] ?? {}) as Record<string, unknown>;
  const itemType = typeof item["type"] === "string" ? (item["type"] as string) : "";
  const id = typeof item["id"] === "string" ? (item["id"] as string) : "";
  const status = typeof item["status"] === "string" ? (item["status"] as string) : "";

  if (itemType === "agent_message") {
    // Only once it has settled: an `item.updated` carries the message so far,
    // and emitting each of those would put a partial reply in the log for
    // every keystroke of it.
    if (!completed) return [];
    const text = typeof item["text"] === "string" ? item["text"].trim() : "";
    return text ? [{ type: "text", agentId, text }] : [];
  }

  // Reasoning is not the reply. It is deliberately dropped rather than shown:
  // it would go into the context snapshot and into the diff summary the
  // Operator writes commit messages from, where a page of the model talking to
  // itself crowds out what it actually did.
  if (itemType === "reasoning") return [];

  const tool = toolNameFor(itemType, item);
  if (!tool) return [];

  const events: AgentEvent[] = [];
  if (!announced.has(id) || id === "") {
    announced.add(id);
    events.push({ type: "tool_call", agentId, toolName: tool.name, input: tool.input });
  }

  if (completed || status === "failed") {
    events.push({
      type: "tool_result",
      agentId,
      toolName: tool.name,
      // Explicit failure, or a non-zero exit from a command. Absent both, a
      // completed item is taken as having worked — Codex says so by setting
      // `status`, and inventing a failure it did not report would be as wrong
      // as inventing a success.
      ok: status !== "failed" && exitCodeOf(item) === 0,
      output: item["output"] ?? item["aggregated_output"] ?? item["error"] ?? tool.input,
    });
  }
  return events;
}

/** Which of Codex's item types are worth showing as a tool call, and as what. */
function toolNameFor(
  itemType: string,
  item: Record<string, unknown>,
): { name: string; input: unknown } | null {
  switch (itemType) {
    case "command_execution":
      return { name: "shell", input: item["command"] };
    case "file_change":
      return { name: "edit", input: item["changes"] ?? item["path"] ?? item["patch"] };
    case "mcp_tool_call": {
      const server = typeof item["server"] === "string" ? item["server"] : "mcp";
      const name = typeof item["tool"] === "string" ? item["tool"] : "call";
      return { name: `${server}/${name}`, input: item["arguments"] ?? item["input"] };
    }
    case "web_search":
      return { name: "web_search", input: item["query"] };
    default:
      // A plan update, or an item type added after this was written. Ignored
      // rather than guessed at.
      return null;
  }
}

/**
 * A command's exit code, or 0 when it did not report one.
 *
 * Only `command_execution` has one; for everything else the absence is not a
 * failure, which is why the default is 0 rather than "unknown".
 */
function exitCodeOf(item: Record<string, unknown>): number {
  const code = item["exit_code"];
  return typeof code === "number" ? code : 0;
}

function describeFailure(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw.trim() || undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const error = raw as Record<string, unknown>;
  const message = error["message"];
  if (typeof message === "string" && message.trim()) return message.trim();
  return JSON.stringify(error);
}

/**
 * Codex's usage block, as its own sample reports it:
 *
 *   {"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,
 *    "reasoning_output_tokens":0}
 *
 * `cached_input_tokens` reads as a subset of `input_tokens` there — 24448 of
 * 24763 — so the cached part is subtracted out rather than added on top.
 * Maya sums `inputTokens + cacheReadTokens` when it totals a run, and
 * reporting both whole would bill a cached prompt twice. The same reasoning
 * applies to `reasoning_output_tokens`, which is left inside `output_tokens`.
 */
function readUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const usage = raw as Record<string, unknown>;
  const input = numberOf(usage["input_tokens"]);
  const cached = numberOf(usage["cached_input_tokens"]);
  const output = numberOf(usage["output_tokens"]);
  if (!input && !output && !cached) return undefined;

  // Clamped, because a cached count larger than the input count would make
  // the fresh input negative and the totals nonsense.
  const fresh = Math.max(0, input - Math.min(cached, input));
  return {
    inputTokens: fresh,
    outputTokens: output,
    ...(cached > 0 ? { cacheReadTokens: Math.min(cached, input) } : {}),
  };
}

function numberOf(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}
