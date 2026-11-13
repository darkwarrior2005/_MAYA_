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

export type AntigravityMode = "accept-edits" | "auto" | "plan";

/**
 * The rule kinds Antigravity's permission patterns use.
 *
 * Taken from the tool itself rather than guessed: these are the kinds it
 * writes with a wildcard, and the examples it carries are `command(npm test)`,
 * `command(git status)`, `command(*)`, `mcp(chrome-devtools/*)` and
 * `mcp(buganizer/get_bugs)`. The `command` target is a command line, not a
 * tool name — `command(run_command)` grants nothing at all.
 */
const PERMISSION_KINDS = [
  "command",
  "mcp",
  "read_file",
  "write_file",
  "read_url",
  "download_url",
  "execute_url",
] as const;

/**
 * What is wrong with a permission pattern, or null when it is fine.
 *
 * Named for its tool because Copilot has one of its own with a different
 * grammar, and the two must never be mistaken for each other: Copilot's
 * `write(src/**)` means nothing here, and `command(npm test)` means nothing
 * there.
 *
 * Checked before the run for the same reason Copilot's are: a pattern
 * Antigravity does not understand grants nothing, silently, and the run then
 * looks like an agent that declined the work. The shape is `kind(target)`.
 */
export function describeBadAntigravityPermission(pattern: string): string | null {
  const text = pattern.trim();
  if (!text) return "an empty string is not a permission pattern";

  const match = /^([a-z_]+)(?:\((.*)\))?$/.exec(text);
  if (!match) {
    return `"${pattern}" is not a permission pattern — Antigravity expects kind(target), as in command(npm test)`;
  }

  const [, kind, target] = match;
  if (!PERMISSION_KINDS.includes(kind as (typeof PERMISSION_KINDS)[number])) {
    // The likeliest mistake, and the one that costs a whole run: naming the
    // tool instead of the permission. Antigravity's tool is `run_command`;
    // the permission over it is `command(...)`.
    const hint = text.includes("command")
      ? ' — did you mean `command(<the command line>)`, for example command("npm test")?'
      : ` — the kinds are ${PERMISSION_KINDS.join(", ")}`;
    return `"${pattern}" is not an Antigravity permission kind${hint}`;
  }
  if (target !== undefined && target.trim() === "") {
    return `"${pattern}" has an empty target — use ${kind}(*) to mean anything`;
  }
  return null;
}

/**
 * The `--settings` payload for a worker's permissions, or null when it has
 * none and nothing should be passed.
 *
 * Every pattern is checked first, and a bad one throws rather than being
 * dropped: silently granting less than a profile asked for is how an agent
 * ends up blamed for refusing work it was never allowed to do.
 */
function buildPermissions(allow?: string[], deny?: string[]): string | null {
  const allowed = allow ?? [];
  const denied = deny ?? [];
  if (allowed.length === 0 && denied.length === 0) return null;

  for (const pattern of [...allowed, ...denied]) {
    const problem = describeBadAntigravityPermission(pattern);
    if (problem) {
      throw new Error(
        `antigravity-cli was given a permission it cannot use: ${problem}. ` +
          "Fix it on this worker in .maya/config.json.",
      );
    }
  }

  return JSON.stringify({
    permissions: {
      ...(allowed.length > 0 ? { allow: allowed } : {}),
      ...(denied.length > 0 ? { deny: denied } : {}),
    },
  });
}

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

/**
 * The argv for one run. Pure and exported, so what Maya actually asks
 * Antigravity to do can be asserted without spawning anything — the first
 * attempt at testing this poked at a property of the handle that does not
 * exist, and passed while checking nothing.
 */
export function buildAntigravityArgs(
  options: AgentRunOptions,
  adapter: AntigravityAdapterOptions = {},
): string[] {
  const args = ["--output-format", "stream-json", "--mode", adapter.mode ?? "accept-edits"];
  if (options.model) args.push("--model", options.model);
  if (options.resumeSessionId) args.push("--conversation", options.resumeSessionId);
  if (adapter.skipPermissions) args.push("--dangerously-skip-permissions");

  // A worker's permissions, as session-only settings.
  //
  // This is the fix for the thing that made an Antigravity worker close to
  // useless for real work: headless `agy` cannot show a permission prompt, so
  // anything needing one was auto-denied — and the run still came back
  // `status: "SUCCESS"` with an empty answer, so it read as an agent that
  // chose to do nothing rather than one that was never allowed. Its own
  // stderr names the way out: an allow-rule under `permissions.allow`.
  // `--settings` takes those for one session and never writes them anywhere,
  // so Maya grants exactly what a worker profile asked for without touching
  // the user's own settings.json.
  //
  // Not a bypass, and invariant 5 still holds: with no `allowedTools` on the
  // profile nothing is passed and the default is unchanged.
  // `--dangerously-skip-permissions` remains opt-in and is still the only
  // thing that approves everything.
  const permissions = buildPermissions(options.allowedTools, options.deniedTools);
  if (permissions) args.push("--settings", permissions);

  args.push("-p", options.prompt);
  return args;
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
    const resolvedPath = await resolveExecutable("agy");
    if (!resolvedPath) {
      return {
        installed: false,
        authenticated: false,
        detail: "`agy` not on PATH — install from antigravity.google/cli (not via npm)",
      };
    }
    return {
      installed: true,
      authenticated: true,
      resolvedPath,
      verified: false,
      detail: "assumes cached credentials from a prior interactive `agy` login (not verified)",
    };
  }

  async start(options: AgentRunOptions): Promise<AgentHandle> {
    const args = buildAntigravityArgs(options, this.options);

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
        // Confirmed against two real failures (agy 1.5.6): a failed tool step
        // arrives as `state: "ERROR"` — a state value nothing here had
        // anticipated — carrying `tool_info.error` as an **object**,
        // `{ type: "TOOL_ERROR", message: "file does not exist" }`. Not a
        // string, and not on the step itself, which is where this used to
        // look first. Success still carries no status of its own, so DONE
        // without an error remains the test for it; that part was right.
        const error = describeToolError(step["error"] ?? info["error"]);
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

      // Permissions it was refused, which `agy` reports and this used to
      // ignore. It matters because a denied run still comes back
      // `status: "SUCCESS"` with an empty response: asked to run a shell
      // command under Maya's default `--mode accept-edits`, the real
      // thing auto-denied it and called the run a success. Without this the
      // only trace was a stderr line in the raw log, and the person is left
      // thinking the agent chose not to do the work when in fact Maya never
      // let it. Not fatal: one denied action does not prove the task failed,
      // and `worker_stopped_short` already covers a run that achieved
      // nothing.
      const denied = deniedActions(result["denied_actions"]);
      if (denied.length > 0) {
        events.push({
          type: "error",
          agentId,
          message:
            `Antigravity was denied ${denied.join(", ")} — headless mode cannot prompt, so it ` +
            "was auto-denied. Allow it under permissions.allow in that tool's settings.json, " +
            "or give this worker a mode that grants it.",
          fatal: false,
        });
      }

      if (status !== "SUCCESS") {
        // `result.error` is where the useful text lives, and it was being
        // thrown away in favour of "run finished with status ERROR". A real
        // one reads: `invalid model selection (--model "not-a-real-model"):
        // model not recognized ... Available models: ...` — the difference
        // between a reader who knows what to fix and one who does not.
        const detail = typeof result["error"] === "string" ? result["error"].trim() : "";
        const reason =
          typeof result["finished_reason"] === "string" ? result["finished_reason"] : "";
        events.push({
          type: "error",
          agentId,
          message:
            detail ||
            `run finished with status ${status || "unknown"}${reason ? ` (${reason})` : ""}`,
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

/**
 * Antigravity's usage block, from three real runs (agy 1.5.6):
 *
 *   input=24050 output=231  cache_read=19721 total=24281
 *   input=13574 output=74   cache_read=8192  total=13648
 *   input=2296  output=70   cache_read=19712 total=2366
 *   input=23978 output=148  cache_read=19724 total=24126   (1.5.8, re-check)
 *
 * Read the first two alone and it looks as though `cache_read_tokens` sits
 * inside `input_tokens`, because `total_tokens` is `input + output` every
 * time and never includes the cache. That is what `codex-cli.ts` found for
 * OpenAI, and subtracting the cached part out there is right.
 *
 * **It is wrong here, and the third run is why: 19712 cached against 2296
 * input.** A subset cannot exceed its set. So Antigravity's `input_tokens`
 * is *already* the fresh part, cached reads are counted separately and
 * excluded from its own total, and both figures are reported whole — the
 * Anthropic convention, not OpenAI's. Two vendors, opposite meanings for the
 * same field name: do not carry this fix from one adapter to another, and do
 * not make an adapter's figures match a tool's own total without checking
 * which definition that total uses. Maya's `totalTokens()` counts cache reads
 * deliberately, so it will read higher than `agy`'s `total_tokens`, and that
 * is a difference of definition rather than a bug to fix.
 *
 * `thinking_tokens` stays inside `output_tokens`: 24050 + 231 is the total
 * with 98 thinking tokens reported, so adding them would double-count.
 */
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

/**
 * A tool step's error as a line of text.
 *
 * It arrives as `{ type: "TOOL_ERROR", message: "file does not exist" }`.
 * Passed through whole it reaches a screen as `[object Object]`, which is
 * worse than nothing — invariant 11 has agent text stripped before drawing,
 * and this is the step before that: making it text at all.
 */
function describeToolError(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw.trim() || undefined;
  if (typeof raw === "object") {
    const error = raw as Record<string, unknown>;
    const message = typeof error["message"] === "string" ? error["message"].trim() : "";
    const kind = typeof error["type"] === "string" ? error["type"] : "";
    if (message) return kind && kind !== "TOOL_ERROR" ? `${kind}: ${message}` : message;
  }
  return JSON.stringify(raw);
}

/** The permissions `agy` says it was refused, named for a person to act on. */
function deniedActions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const denied = entry as Record<string, unknown>;
      const display = typeof denied["display_name"] === "string" ? denied["display_name"] : "";
      const action = typeof denied["action"] === "string" ? denied["action"] : "";
      return display && action ? `${display} (${action})` : display || action;
    })
    .filter((name): name is string => name.length > 0);
}
