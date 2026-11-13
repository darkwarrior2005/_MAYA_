import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDescriptor, AgentEvent } from "@maya/shared-types";
import { EventBus } from "../src/bus/event-bus.js";
import { EventStore } from "../src/bus/event-store.js";
import { RepoManager } from "../src/git/repo-manager.js";
import { TaskRunner, lastWords } from "../src/orchestrator/task-runner.js";
import { makeTempRepo, onCleanup, runCleanups, safeRemove, StubAdapter } from "./helpers.js";

afterEach(runCleanups);

const agent: AgentDescriptor = {
  id: "worker-1",
  role: "worker",
  tool: "claude-code",
  displayName: "Stub Worker",
};

const says = (text: string): AgentEvent => ({ type: "text", agentId: "worker-1", text });

/**
 * What two live agents actually said when given a task they could not do
 * honestly: delete whichever of two near-identical price lists is unused, in
 * a repository that nowhere says which. Quoted rather than invented, because
 * the shape of real refusals is the whole point — the second one contains no
 * question mark at all.
 */
const CODEX_ASKED =
  "Which list is currently used: `prices-alpha.csv` or `prices-beta.csv`? Neither " +
  "pricing.md nor the Git history identifies the active one, so I need that detail " +
  "before deleting either file.";

const CLAUDE_JUST_STOPPED =
  "Neither file says which list is in use. Both CSVs have the same SKUs and only the " +
  "prices differ. `pricing.md` only says \"exactly one list is active,\" without naming " +
  "it. Deleting the wrong file would remove the prices customers are actually charged, " +
  "so I've stopped here instead of guessing.";

async function setup(adapter: StubAdapter) {
  const dir = await makeTempRepo();
  const repo = new RepoManager(dir);
  await repo.openOrInit();
  const store = new EventStore(repo.paths.dbFile);
  onCleanup(() => store.close());
  onCleanup(() => safeRemove(dir));
  const bus = new EventBus(store);
  return { dir, store, runner: new TaskRunner(repo, adapter, bus) };
}

const stoppedShortEvents = (store: EventStore) =>
  store.since(0).filter((event) => event.payload.type === "worker_stopped_short");

describe("a worker that reported success, changed nothing and asked nobody", () => {
  it("says so, quoting what it said, when it asked in prose", async () => {
    // Codex does this. The run is reported ok and the question sits unread in
    // the transcript, so before this the person was never asked and nothing
    // on screen said why the task did not happen.
    const adapter = new StubAdapter({ events: [says(CODEX_ASKED)] });
    const { store, runner } = await setup(adapter);

    const outcome = await runner.run({ instruction: "delete the unused price list", agent });

    expect(outcome.ok).toBe(true);
    expect(outcome.committed).toBeNull();
    expect(outcome.stoppedShort?.lastWords).toContain("Which list is currently used");

    const reported = stoppedShortEvents(store);
    expect(reported).toHaveLength(1);
    // On the secret channel: that panel exists to put in front of the person
    // what they must act on, and being asked nothing is how this failure
    // feels from their side.
    expect(reported[0]?.channel).toBe("secret");
    expect(reported[0]?.payload).toMatchObject({
      type: "worker_stopped_short",
      agentId: "worker-1",
      taskId: outcome.taskId,
    });
  });

  it("fires even when the worker never asked a question at all", async () => {
    // The robustness claim, and the reason this looks for neither a marker
    // nor a question mark: Claude Code, before its briefing was rewritten,
    // narrated being stuck without asking anything. A detector hunting for
    // "?" would have missed it entirely.
    expect(CLAUDE_JUST_STOPPED).not.toContain("?");

    const adapter = new StubAdapter({ events: [says(CLAUDE_JUST_STOPPED)] });
    const { store, runner } = await setup(adapter);

    const outcome = await runner.run({ instruction: "delete the unused price list", agent });

    expect(outcome.stoppedShort?.lastWords).toContain("stopped here instead of guessing");
    expect(stoppedShortEvents(store)).toHaveLength(1);
  });

  it("reports a worker that said nothing at all", async () => {
    // The quietest version, and the one that used to slip through: the quote
    // decided whether anything was published, so a worker with no words
    // produced no report. Antigravity does this when every tool it tries is
    // denied — tool calls, no text — which is precisely when the person most
    // needs telling.
    const adapter = new StubAdapter({
      events: [{ type: "tool_call", agentId: "worker-1", toolName: "run_command", input: {} }],
    });
    const { store, runner } = await setup(adapter);

    const outcome = await runner.run({ instruction: "run the build", agent });

    expect(outcome.stoppedShort).toBeDefined();
    expect(outcome.stoppedShort?.lastWords).toBeUndefined();

    const reported = stoppedShortEvents(store);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.payload).toMatchObject({ type: "worker_stopped_short" });
    expect(reported[0]?.payload).not.toHaveProperty("lastWords");
  });

  it("stays quiet when the worker did reach the person", async () => {
    // It used `@user`. The question is already in front of them, and saying
    // it twice would train people to ignore the panel.
    const adapter = new StubAdapter({
      events: [says("@user Which price list is the live one?")],
    });
    const { store, runner } = await setup(adapter);

    const outcome = await runner.run({ instruction: "delete the unused price list", agent });

    expect(outcome.stoppedShort).toBeUndefined();
    expect(stoppedShortEvents(store)).toHaveLength(0);
    const asked = store.since(0).filter((event) => event.payload.type === "agent_message");
    expect(asked).toHaveLength(1);
  });

  it("stays quiet when the worker asked the Operator", async () => {
    const adapter = new StubAdapter({
      events: [says("@operator Has another worker already settled the price list?")],
    });
    const { store, runner } = await setup(adapter);

    const outcome = await runner.run({ instruction: "delete the unused price list", agent });

    expect(outcome.stoppedShort).toBeUndefined();
    expect(stoppedShortEvents(store)).toHaveLength(0);
    expect(store.since(0).some((event) => event.payload.type === "agent_question")).toBe(true);
  });

  it("stays quiet when the worker actually did the work", async () => {
    const adapter = new StubAdapter({
      events: [says("Removed the unused list. Anything else?")],
      writes: { "done.txt": "the work\n" },
    });
    const { dir, store, runner } = await setup(adapter);

    const outcome = await runner.run({ instruction: "delete the unused price list", agent });

    // A trailing question in a run that changed something is conversation,
    // not a worker stuck. The commit is what settles it.
    expect(outcome.committed).toBeTruthy();
    expect(outcome.stoppedShort).toBeUndefined();
    expect(stoppedShortEvents(store)).toHaveLength(0);
    expect(existsSync(join(dir, "done.txt"))).toBe(true);
  });

  it("stays quiet when the run failed, which is already reported", async () => {
    // A failure is visible as a failure. This is only for the case that
    // looks like success.
    const adapter = new StubAdapter({ ok: false, events: [says("I could not work out which.")] });
    const { store, runner } = await setup(adapter);

    const outcome = await runner.run({ instruction: "delete the unused price list", agent });

    expect(outcome.ok).toBe(false);
    expect(outcome.stoppedShort).toBeUndefined();
    expect(stoppedShortEvents(store)).toHaveLength(0);
  });
});

describe("lastWords", () => {
  it("takes the agent's final say", () => {
    expect(lastWords(["thinking about it", "here is why I stopped"])).toBe(
      "here is why I stopped",
    );
  });

  it("skips the publisher's own tool annotations", () => {
    // `[tool] Bash` is Maya's note that a tool ran, not the agent talking,
    // and quoting it back to the person would say nothing at all.
    expect(lastWords(["the real explanation", "[tool] Bash", "[tool] Read"])).toBe(
      "the real explanation",
    );
  });

  it("has nothing to say when the agent never spoke", () => {
    expect(lastWords([])).toBeNull();
    expect(lastWords(["[tool] Bash"])).toBeNull();
    expect(lastWords(["   "])).toBeNull();
  });

  it("caps a long explanation, since the full text is in the transcript", () => {
    const capped = lastWords([`${"x".repeat(900)} tail`]);
    expect(capped?.length).toBeLessThan(700);
    expect(capped?.endsWith("…")).toBe(true);
  });
});
