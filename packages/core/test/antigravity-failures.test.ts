import { describe, expect, it } from "vitest";
import { makeAntigravityParser } from "../src/adapters/antigravity-cli.js";
import { totalTokens } from "../src/usage/token-tracker.js";

/**
 * Captured from real `agy` 1.5.6 runs, copied rather than composed, and
 * re-checked against 1.5.8 a day later — `agy` updates itself, so these
 * samples are a record of one version rather than a contract. The re-check
 * found the same `state: "ERROR"`, the same `{ type, message }` error object
 * and the same token arithmetic (23978 + 148 = 24126, cache excluded).
 *
 * This is `bugfixy.md` B3: the adapter's failure handling was inferred from
 * the documentation because no failing sample existed, and the note said to
 * confirm it the next time Antigravity failed. These are those failures,
 * produced on purpose — a read of a file that is not there, and a shell
 * command under Maya's default mode, which headless Antigravity auto-denies.
 */
const TOOL_ERROR_STEP = {
  event: "step_update",
  step_update: {
    conversation_id: "6b6faed3-e567-448e-a572-4b8cda1f7825",
    step_index: 2,
    state: "ERROR",
    step_type: "tool",
    tool_name: "read_file",
    duration_seconds: 0.0920107,
    tool_info: {
      name: "read_file",
      parameters: { EndLine: 1, Path: "C:\\tmp\\definitely-not-here.txt", StartLine: 1 },
      error: { type: "TOOL_ERROR", message: "file does not exist" },
    },
  },
};

/** A tool error does not fail the run: the agent reported the problem and stopped. */
const RESULT_AFTER_TOOL_ERROR = {
  event: "result",
  result: {
    conversation_id: "6b6faed3-e567-448e-a572-4b8cda1f7825",
    status: "SUCCESS",
    response: "The file `./definitely-not-here.txt` does not exist.\n",
    duration_seconds: 116.8385651,
    num_turns: 1,
    usage: {
      input_tokens: 24050,
      output_tokens: 231,
      thinking_tokens: 98,
      cache_read_tokens: 19721,
      total_tokens: 24281,
    },
  },
};

const RESULT_WITH_DENIAL = {
  event: "result",
  result: {
    conversation_id: "e810fc01-ace5-441e-b85e-4a816fac1ed2",
    status: "SUCCESS",
    response: "",
    duration_seconds: 39.7551519,
    num_turns: 1,
    usage: {
      input_tokens: 13574,
      output_tokens: 74,
      thinking_tokens: 22,
      cache_read_tokens: 8192,
      total_tokens: 13648,
    },
    denied_actions: [{ action: "command", display_name: "RunCommand" }],
  },
};

const RESULT_FATAL = {
  event: "result",
  result: {
    conversation_id: "",
    status: "ERROR",
    response: "",
    error:
      'invalid model selection (--model "not-a-real-model" --effort ""): model ' +
      "not-a-real-model is not recognized as a known model or custom model in settings",
    duration_seconds: 0,
    num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    finished_reason: "error",
  },
};

const line = (value: unknown): string => JSON.stringify(value);

describe("Antigravity's failure shapes, from real runs", () => {
  it("reads a failed tool step, which arrives in a state nothing expected", () => {
    // `state: "ERROR"` was not among the values this parser knew about. It
    // happened to come out right because the error object is truthy, which is
    // luck rather than handling.
    const parse = makeAntigravityParser();
    const [result] = parse(line(TOOL_ERROR_STEP), "w");
    expect(result).toMatchObject({ type: "tool_result", toolName: "read_file", ok: false });
  });

  it("makes the error readable instead of passing an object to the screen", () => {
    // tool_info.error is `{ type, message }`, not a string. Sent through
    // whole it reaches a pane as "[object Object]", which tells nobody
    // anything.
    const parse = makeAntigravityParser();
    const [result] = parse(line(TOOL_ERROR_STEP), "w");
    expect(result).toMatchObject({ output: "file does not exist" });
    expect(String((result as { output: unknown }).output)).not.toContain("object Object");
  });

  it("does not treat a failed tool as a failed run", () => {
    // Antigravity reported SUCCESS here, and it was right: the agent read the
    // error, explained it and finished. Invariant 3 runs the other way —
    // reported success is not success — but it does not licence inventing a
    // failure the tool never claimed.
    const parse = makeAntigravityParser();
    parse(line(TOOL_ERROR_STEP), "w");
    const events = parse(line(RESULT_AFTER_TOOL_ERROR), "w");
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "done", ok: true });
  });

  it("reports input and cached reads whole, because here they are separate", () => {
    // Worth pinning, because the opposite looks right. `total_tokens` is
    // input + output and never counts the cache, which reads exactly like
    // OpenAI's convention where the cached part sits inside the input and
    // `codex-cli.ts` subtracts it out. Copying that here is a bug.
    const parse = makeAntigravityParser();
    const events = parse(line(RESULT_AFTER_TOOL_ERROR), "w");
    expect(events.find((event) => event.type === "usage")).toMatchObject({
      usage: { inputTokens: 24050, outputTokens: 231, cacheReadTokens: 19721 },
    });
  });

  it("survives a cache figure larger than the input, which is the proof", () => {
    // A real run: 19712 cached against 2296 input. A subset cannot exceed its
    // set, so `input_tokens` must already be the fresh part. Subtracting
    // would have clamped the input to zero and understated the cache by 17k
    // while still producing a plausible-looking total.
    const parse = makeAntigravityParser();
    const events = parse(
      line({
        event: "result",
        result: {
          status: "SUCCESS",
          conversation_id: "44701d65",
          usage: {
            input_tokens: 2296,
            output_tokens: 70,
            thinking_tokens: 22,
            cache_read_tokens: 19712,
            total_tokens: 2366,
          },
        },
      }),
      "w",
    );
    const usage = events.find((event) => event.type === "usage");
    expect(usage).toMatchObject({
      usage: { inputTokens: 2296, outputTokens: 70, cacheReadTokens: 19712 },
    });

    // Maya counts cache reads in its own totals on purpose, so its figure is
    // higher than Antigravity's `total_tokens`. A difference of definition,
    // not an error — see the note on readUsage.
    const reported = (usage as { usage: Parameters<typeof totalTokens>[0] }).usage;
    expect(totalTokens(reported)).toBe(2296 + 70 + 19712);
    expect(totalTokens(reported)).toBeGreaterThan(2366);
  });

  it("leaves thinking tokens where Antigravity counts them", () => {
    // 98 thinking tokens, and the total does not include them, so they are
    // already inside output_tokens. Adding them would overstate again.
    const parse = makeAntigravityParser();
    const events = parse(line(RESULT_AFTER_TOOL_ERROR), "w");
    const usage = events.find((event) => event.type === "usage");
    expect((usage as { usage: { outputTokens: number } }).usage.outputTokens).toBe(231);
  });

  it("reports a permission it was refused, which a SUCCESS otherwise hides", () => {
    // The run that mattered most: asked to run a shell command under
    // `--mode accept-edits`, headless Antigravity auto-denied it, produced an
    // empty response, and called the run a SUCCESS. The only trace was a line
    // on stderr. A reader would conclude the agent declined the task.
    const parse = makeAntigravityParser();
    const events = parse(line(RESULT_WITH_DENIAL), "w");

    const denial = events.find((event) => event.type === "error");
    expect(denial).toMatchObject({ fatal: false });
    expect((denial as { message: string }).message).toContain("RunCommand");
    expect((denial as { message: string }).message).toContain("permissions.allow");

    // Not fatal: one refused action does not prove the task failed, and the
    // run still reports what Antigravity said it did.
    expect(events.at(-1)).toMatchObject({ type: "done", ok: true });
  });

  it("passes on the reason a run failed instead of restating its status", () => {
    // `result.error` was being discarded in favour of "run finished with
    // status ERROR". The real text names the flag and lists what was
    // available, which is the whole difference for whoever reads it.
    const parse = makeAntigravityParser();
    const events = parse(line(RESULT_FATAL), "w");

    const failure = events.find((event) => event.type === "error");
    expect(failure).toMatchObject({ fatal: true });
    expect((failure as { message: string }).message).toContain("invalid model selection");
    expect((failure as { message: string }).message).not.toContain("run finished with status");
    expect(events.at(-1)).toMatchObject({ type: "done", ok: false });
  });

  it("still describes a failure that carries no message of its own", () => {
    const parse = makeAntigravityParser();
    const events = parse(
      line({ event: "result", result: { status: "CANCELLED", finished_reason: "interrupted" } }),
      "w",
    );
    const failure = events.find((event) => event.type === "error");
    expect((failure as { message: string }).message).toBe(
      "run finished with status CANCELLED (interrupted)",
    );
  });
});
