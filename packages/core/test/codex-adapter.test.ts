// The Codex adapter: the stream parser, the command line, and the two places
// it refuses rather than guesses.
//
// Every event shape below is from OpenAI's own non-interactive documentation,
// which publishes a worked sample of `codex exec --json`. `codex` was not
// installed on the machine this was written on, so unlike the Copilot and
// Antigravity fixtures these are documented shapes rather than captured ones —
// which is exactly why the parser is tested for what it does with a shape it
// does not recognise.
import { describe, expect, it } from "vitest";
import { CodexCliAdapter, buildCodexArgs, makeCodexParser } from "../src/adapters/codex-cli.js";
import type { AgentRunOptions } from "../src/adapters/adapter.js";

/** The documented sample, line by line. */
const SAMPLE = {
  threadStarted: {
    type: "thread.started",
    thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53",
  },
  turnStarted: { type: "turn.started" },
  commandStarted: {
    type: "item.started",
    item: { id: "item_1", type: "command_execution", command: "bash -lc ls", status: "in_progress" },
  },
  commandCompleted: {
    type: "item.completed",
    item: {
      id: "item_1",
      type: "command_execution",
      command: "bash -lc ls",
      status: "completed",
      exit_code: 0,
      aggregated_output: "docs sdk examples",
    },
  },
  agentMessage: {
    type: "item.completed",
    item: {
      id: "item_3",
      type: "agent_message",
      text: "Repo contains docs, sdk, and examples directories.",
    },
  },
  turnCompleted: {
    type: "turn.completed",
    usage: {
      input_tokens: 24763,
      cached_input_tokens: 24448,
      output_tokens: 122,
      reasoning_output_tokens: 0,
    },
  },
};

const line = (value: unknown): string => JSON.stringify(value);

describe("Codex stream parsing", () => {
  it("takes the session id from the first event, so a run can be resumed", () => {
    const parse = makeCodexParser();
    expect(parse(line(SAMPLE.threadStarted), "w")).toEqual([
      { type: "status", agentId: "w", status: "running" },
    ]);

    // The id is not emitted on its own; it arrives attached to `done`, which
    // is where TaskRunner reads it from.
    parse(line(SAMPLE.turnStarted), "w");
    const finished = parse(line(SAMPLE.turnCompleted), "w");
    const done = finished.find((event) => event.type === "done");
    expect(done).toMatchObject({ ok: true, sessionId: "0199a213-81c0-7800-8aa1-bbab2a035a53" });
  });

  it("reports a command as a call and then its outcome", () => {
    const parse = makeCodexParser();
    expect(parse(line(SAMPLE.commandStarted), "w")).toEqual([
      { type: "tool_call", agentId: "w", toolName: "shell", input: "bash -lc ls" },
    ]);
    expect(parse(line(SAMPLE.commandCompleted), "w")).toEqual([
      {
        type: "tool_result",
        agentId: "w",
        toolName: "shell",
        ok: true,
        output: "docs sdk examples",
      },
    ]);
  });

  it("reads a non-zero exit as a failed tool call", () => {
    const parse = makeCodexParser();
    parse(line(SAMPLE.commandStarted), "w");
    const events = parse(
      line({
        type: "item.completed",
        item: {
          id: "item_1",
          type: "command_execution",
          command: "bash -lc false",
          status: "completed",
          exit_code: 1,
        },
      }),
      "w",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "tool_result", ok: false });
  });

  it("announces a call for an item that only ever arrives completed", () => {
    // The docs say file_change and web_search are emitted as item.completed
    // only. Without this, a file the agent wrote would show a result with no
    // call in front of it.
    const parse = makeCodexParser();
    const events = parse(
      line({
        type: "item.completed",
        item: { id: "item_9", type: "file_change", status: "completed", path: "README.md" },
      }),
      "w",
    );
    expect(events.map((event) => event.type)).toEqual(["tool_call", "tool_result"]);
    expect(events[0]).toMatchObject({ toolName: "edit", input: "README.md" });
  });

  it("emits the settled reply once, not every partial of it", () => {
    const parse = makeCodexParser();
    const partial = parse(
      line({
        type: "item.updated",
        item: { id: "item_3", type: "agent_message", text: "Repo contains", status: "in_progress" },
      }),
      "w",
    );
    expect(partial).toEqual([]);

    expect(parse(line(SAMPLE.agentMessage), "w")).toEqual([
      {
        type: "text",
        agentId: "w",
        text: "Repo contains docs, sdk, and examples directories.",
      },
    ]);
  });

  it("drops reasoning, which is not the reply", () => {
    const parse = makeCodexParser();
    const events = parse(
      line({
        type: "item.completed",
        item: { id: "item_2", type: "reasoning", text: "I should list the files first." },
      }),
      "w",
    );
    expect(events).toEqual([]);
  });

  it("does not count a cached prompt twice", () => {
    // 24448 of the 24763 input tokens were cached, so the fresh input is 315.
    // Maya sums inputTokens + cacheReadTokens, so reporting both whole would
    // bill this run at nearly 50k input tokens instead of 24763.
    const parse = makeCodexParser();
    const events = parse(line(SAMPLE.turnCompleted), "w");
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toMatchObject({
      usage: { inputTokens: 315, cacheReadTokens: 24448, outputTokens: 122 },
    });

    const total = 315 + 24448;
    expect(total).toBe(24763);
  });

  it("reads the cache-write count the real stream carries", () => {
    // Captured from codex-cli 0.167.1, which reports a field the published
    // sample did not: cache_write_input_tokens. Read as a subset of the input
    // on the same reasoning as the cached count — writing a cache entry is
    // something done to tokens that were sent, not extra tokens — so the
    // reported figures must still sum to input_tokens.
    const parse = makeCodexParser();
    const events = parse(
      line({
        type: "turn.completed",
        usage: {
          input_tokens: 21468,
          cached_input_tokens: 13696,
          cache_write_input_tokens: 4096,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      }),
      "w",
    );
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toMatchObject({
      usage: {
        inputTokens: 21468 - 13696,
        cacheReadTokens: 13696,
        cacheWriteTokens: 4096,
        outputTokens: 5,
      },
    });
  });

  it("leaves the cache-write count out when it is zero, as it usually is", () => {
    // The real run reported 0 here, and an explicit zero in the Info Panel
    // reads as a measurement rather than an absence.
    const parse = makeCodexParser();
    const events = parse(
      line({
        type: "turn.completed",
        usage: {
          input_tokens: 21468,
          cached_input_tokens: 13696,
          cache_write_input_tokens: 0,
          output_tokens: 5,
        },
      }),
      "w",
    );
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toMatchObject({ usage: { inputTokens: 7772, outputTokens: 5 } });
    expect(usage && "usage" in usage ? usage.usage : {}).not.toHaveProperty(
      "cacheWriteTokens",
    );
  });

  it("treats a failed turn as fatal and not done cleanly", () => {
    const parse = makeCodexParser();
    const events = parse(
      line({
        type: "turn.failed",
        error: { message: "model request failed: 429" },
      }),
      "w",
    );
    expect(events).toEqual([
      { type: "error", agentId: "w", message: "model request failed: 429", fatal: true },
      { type: "done", agentId: "w", ok: false },
    ]);
  });

  it("does not report a clean finish after an error, whatever the turn says", () => {
    // The invariant: a tool's reported success is not success. Codex emits
    // `error` and may still close the turn with `turn.completed`.
    const parse = makeCodexParser();
    parse(line(SAMPLE.threadStarted), "w");
    parse(line({ type: "error", message: "stream disconnected" }), "w");
    const finished = parse(line(SAMPLE.turnCompleted), "w");
    expect(finished.find((event) => event.type === "done")).toMatchObject({ ok: false });
  });

  it("ignores an item type it has never heard of rather than guessing", () => {
    const parse = makeCodexParser();
    expect(
      parse(
        line({
          type: "item.completed",
          item: { id: "item_7", type: "something_added_later", status: "completed" },
        }),
        "w",
      ),
    ).toEqual([]);
    expect(parse("not json at all", "w")).toEqual([]);
    expect(parse("", "w")).toEqual([]);
  });
});

const run = (extra: Partial<AgentRunOptions> = {}): AgentRunOptions => ({
  agentId: "w",
  cwd: "/tmp/work",
  prompt: "do the thing",
  ...extra,
});

describe("the Codex command line", () => {
  it("asks for workspace-write, because exec defaults to read-only", () => {
    // Without this a worker cannot change a single file, and the run looks
    // like an agent that chose not to do the task.
    const args = buildCodexArgs(run());
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("workspace-write");
  });

  it("never reaches for the bypass flag on its own", () => {
    const args = buildCodexArgs(run());
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("danger-full-access");
  });

  it("uses the bypass only when a project explicitly opted in", () => {
    const args = buildCodexArgs(run(), { dangerouslyBypassSandbox: true });
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    // And then there is no sandbox to set: the two conflict.
    expect(args).not.toContain("--sandbox");
  });

  it("honours a tighter sandbox a project asked for", () => {
    const args = buildCodexArgs(run(), { sandbox: "read-only" });
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
  });

  it("asks Codex to read the prompt from stdin, and never puts it on the command line", () => {
    // Measured, not theoretical: an npm-installed `codex` is a .cmd, so the
    // command line goes through cmd.exe, which expands %NAME% inside a quoted
    // argument. A prompt reading "Explain what %PATH% means" arrived with the
    // machine's whole PATH spliced into it — a mangled prompt and the user's
    // directory layout handed to a third-party tool. Stdin has no such layer.
    const prompt = "Explain what %PATH% means and --help the parser";
    const args = buildCodexArgs(run({ prompt }));
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("-");
    expect(args).not.toContain(prompt);
    expect(args.some((arg) => arg.includes("%"))).toBe(false);
  });

  it("keeps exec's own flags in front of the resume subcommand", () => {
    const args = buildCodexArgs(run({ resumeSessionId: "0199a213" }));
    const resumeAt = args.indexOf("resume");
    expect(resumeAt).toBeGreaterThan(args.indexOf("--json"));
    expect(resumeAt).toBeGreaterThan(args.indexOf("--sandbox"));
    expect(args[resumeAt + 1]).toBe("0199a213");
    // The follow-up prompt is read from stdin here too.
    expect(args.at(-1)).toBe("-");
  });

  it("passes a model through when the worker names one", () => {
    const args = buildCodexArgs(run({ model: "gpt-6.1-sol" }));
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-6.1-sol");
  });

  it("refuses a Copilot-style tool list instead of silently dropping it", async () => {
    const adapter = new CodexCliAdapter();
    await expect(
      adapter.start({
        agentId: "w",
        cwd: process.cwd(),
        prompt: "do the thing",
        allowedTools: ["write"],
      }),
    ).rejects.toThrow(/sandbox policy, not a tool list/);
  });

  it("names the setting that replaces it, so the fix is in the message", async () => {
    const adapter = new CodexCliAdapter();
    await expect(
      adapter.start({
        agentId: "w",
        cwd: process.cwd(),
        prompt: "do the thing",
        deniedTools: ["shell(rm:*)"],
      }),
    ).rejects.toThrow(/"sandbox"/);
  });

  it("says it can resume, because codex exec resume takes a session id", () => {
    expect(new CodexCliAdapter().capabilities.resumable).toBe(true);
  });

  it("reports itself as not installed when codex is not on PATH", async () => {
    const health = await new CodexCliAdapter().check();
    // Either answer is correct depending on the machine; what must not happen
    // is a claim of being logged in on a machine with no codex at all.
    if (!health.installed) {
      expect(health.authenticated).toBe(false);
      expect(health.detail).toContain("codex login");
    } else {
      expect(health.detail).toBeDefined();
    }
  });
});
