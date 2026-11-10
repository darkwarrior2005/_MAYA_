import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@maya/shared-types";
import type {
  AdapterHealth,
  AgentAdapter,
  AgentHandle,
  AgentRunOptions,
} from "../src/adapters/adapter.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { EventBus } from "../src/bus/event-bus.js";
import { EventStore } from "../src/bus/event-store.js";
import type { WorkerProfile } from "../src/config/maya-config.js";
import { RepoManager } from "../src/git/repo-manager.js";
import { Operator } from "../src/orchestrator/operator.js";
import {
  BusConflictResolver,
  HoldOnConflictResolver,
  type ConflictAnswer,
  type ConflictRequest,
} from "../src/orchestrator/conflict-resolver.js";
import { TaskQueue } from "../src/orchestrator/task-queue.js";
import { makeTempRepo, onCleanup, runCleanups, safeRemove, StubAdapter } from "./helpers.js";

afterEach(runCleanups);

function profile(id: string, overrides: Partial<WorkerProfile> = {}): WorkerProfile {
  return {
    id,
    tool: "claude-code",
    displayName: id,
    stallTimeoutSec: 5,
    enabled: true,
    ...overrides,
  };
}

async function setup(adapter: AgentAdapter, workers: WorkerProfile[]) {
  const dir = await makeTempRepo();
  const repo = new RepoManager(dir);
  await repo.openOrInit();
  const store = new EventStore(repo.paths.dbFile);
  onCleanup(() => store.close());
  onCleanup(() => safeRemove(dir));
  const bus = new EventBus(store);
  const queue = new TaskQueue(store.database);
  const registry = new AdapterRegistry().register(adapter);

  const operator = new Operator({
    repo,
    registry,
    bus,
    queue,
    conflicts: new HoldOnConflictResolver(bus),
    workers,
  });

  return { dir, repo, store, bus, queue, operator };
}

describe("Operator", () => {
  it("runs workers in parallel worktrees and merges each result into main", async () => {
    const adapter = new StubAdapter({ writes: { "notes.txt": "done\n" } });
    const { dir, queue, operator } = await setup(adapter, [
      profile("worker-a"),
      profile("worker-b"),
    ]);

    const report = await operator.run(["build feature A", "build feature B"]);

    expect(report.outcomes).toHaveLength(2);
    expect(report.outcomes.map((o) => o.agent.id).sort()).toEqual(["worker-a", "worker-b"]);
    expect(report.merged).toHaveLength(2);
    expect(report.held).toHaveLength(0);

    // Both tasks reached main, and the queue agrees.
    const log = await simpleGit(dir).log();
    expect(log.all.some((c) => c.message.includes("build feature A"))).toBe(true);
    expect(log.all.some((c) => c.message.includes("build feature B"))).toBe(true);
    expect(queue.all().every((t) => t.state === "merged")).toBe(true);

  });

  it("cleans up worktrees so the state dir does not accumulate checkouts", async () => {
    const adapter = new StubAdapter({ writes: { "a.txt": "x\n" } });
    const { dir, repo, operator } = await setup(adapter, [profile("worker-a")]);

    await operator.run(["do a thing"]);

    const worktreeRoot = join(repo.paths.stateDir, "worktrees");
    const remaining = existsSync(worktreeRoot)
      ? (await import("node:fs")).readdirSync(worktreeRoot)
      : [];
    expect(remaining).toHaveLength(0);

    // git itself should only know about the main checkout
    const list = await simpleGit(dir).raw(["worktree", "list", "--porcelain"]);
    expect(list.split("worktree ").filter(Boolean)).toHaveLength(1);

  });

  it("holds a conflicting branch instead of forcing it into main", async () => {
    // Each worker writes different text to the same file, so the second merge
    // must conflict rather than fast-forward.
    const adapter = new StubAdapter({ writes: { "shared.txt": "version from {agent}\n" } });
    const { dir, queue, operator } = await setup(adapter, [
      profile("worker-a"),
      profile("worker-b"),
    ]);

    const report = await operator.run(["edit shared one way", "edit shared another way"]);

    expect(report.merged).toHaveLength(1);
    expect(report.held).toHaveLength(1);

    // main must be clean and hold exactly one version of the file
    const git = simpleGit(dir);
    expect((await git.status()).isClean()).toBe(true);
    expect(readFileSync(join(dir, "shared.txt"), "utf8")).not.toContain("<<<<<<<");

    const blocked = queue.all().filter((t) => t.state === "blocked");
    expect(blocked).toHaveLength(1);

  });

  it("never merges a stalled worker and records it as failed", async () => {
    const adapter = new StubAdapter({ hang: true });
    const { queue, operator } = await setup(adapter, [
      profile("worker-a", { stallTimeoutSec: 0.2 }),
    ]);

    const report = await operator.run(["hang forever"]);

    expect(report.outcomes[0]?.stalled).toBe(true);
    expect(report.merged).toHaveLength(0);
    expect(queue.all()[0]?.state).toBe("failed");

  });

  it("records every task in the queue for the agents-to-do view", async () => {
    const adapter = new StubAdapter({ writes: { "x.txt": "x\n" } });
    const { queue, operator } = await setup(adapter, [profile("worker-a")]);

    await operator.run(["first task", "second task"]);

    const all = queue.all();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.summary)).toEqual(["first task", "second task"]);
    expect(all.every((t) => t.assignedTo === "worker-a")).toBe(true);
    expect(queue.active()).toHaveLength(0);

  });
});

describe("Operator scheduling", () => {
  /** Records when each run started and finished, so overlap is visible. */
  class TimedAdapter implements AgentAdapter {
    readonly id = "claude-code" as const;
    readonly displayName = "Timed";
    readonly capabilities = { streaming: false, structuredOutput: false, resumable: false };
    readonly timeline: Array<{ agentId: string; event: "start" | "finish"; at: number }> = [];

    async check(): Promise<AdapterHealth> {
      return { installed: true, authenticated: true };
    }

    async start(options: AgentRunOptions): Promise<AgentHandle> {
      const timeline = this.timeline;
      return {
        agentId: options.agentId,
        onEvent: () => () => {},
        waitForCompletion: async () => {
          timeline.push({ agentId: options.agentId, event: "start", at: Date.now() });
          await new Promise((resolve) => setTimeout(resolve, 120));
          timeline.push({ agentId: options.agentId, event: "finish", at: Date.now() });
          return { ok: true, stalled: false };
        },
        interrupt: async () => {},
        kill: async () => {},
      };
    }
  }

  /** True when a run of the same agent began before an earlier one ended. */
  function overlapped(timeline: TimedAdapter["timeline"]): boolean {
    const open = new Map<string, number>();
    for (const entry of timeline) {
      const count = open.get(entry.agentId) ?? 0;
      if (entry.event === "start") {
        if (count > 0) return true;
        open.set(entry.agentId, count + 1);
      } else {
        open.set(entry.agentId, count - 1);
      }
    }
    return false;
  }

  it("gives one worker its tasks one at a time", async () => {
    const adapter = new TimedAdapter();
    const { operator } = await setup(adapter, [profile("worker-one")]);

    // Three tasks, one worker. Handing them all out at once ran them
    // simultaneously, which interleaves the worker's log and loses all but
    // the last context snapshot.
    const report = await operator.run(["alpha", "beta", "gamma"]);

    expect(report.outcomes).toHaveLength(3);
    expect(overlapped(adapter.timeline)).toBe(false);
    expect(adapter.timeline.filter((entry) => entry.event === "start")).toHaveLength(3);
  });

  it("still runs different workers at the same time", async () => {
    const adapter = new TimedAdapter();
    const { operator } = await setup(adapter, [profile("worker-a"), profile("worker-b")]);

    const started = Date.now();
    await operator.run(["alpha", "beta"]);
    const elapsed = Date.now() - started;

    const agents = new Set(adapter.timeline.map((entry) => entry.agentId));
    expect(agents.size).toBe(2);
    // Two 120ms runs in parallel, not one after the other.
    expect(elapsed).toBeLessThan(2000);
  });

  it("reports outcomes in the order the tasks were given", async () => {
    const adapter = new TimedAdapter();
    const { operator } = await setup(adapter, [profile("worker-one")]);
    const report = await operator.run(["alpha", "beta", "gamma"]);
    expect(report.outcomes.map((outcome) => outcome.task.summary)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });
});

describe("Operator planning", () => {
  /**
   * An operator adapter that answers with a fixed plan. It takes a tool id of
   * its own so the registry can hold it alongside the worker stub, which is
   * registered as "claude-code".
   */
  function planningAdapter(answer: string): AgentAdapter {
    return {
      id: "copilot-cli",
      displayName: "Operator",
      capabilities: { streaming: true, structuredOutput: false, resumable: false },
      async check(): Promise<AdapterHealth> {
        return { installed: true, authenticated: true };
      },
      async start(options: AgentRunOptions): Promise<AgentHandle> {
        const listeners = new Set<(event: AgentEvent) => void>();
        return {
          agentId: options.agentId,
          onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          waitForCompletion: async () => {
            for (const listener of listeners) {
              listener({ type: "text", agentId: options.agentId, text: answer });
            }
            return { ok: true, stalled: false };
          },
          interrupt: async () => {},
          kill: async () => {},
        };
      },
    };
  }

  /** Answers the Operator's question with whatever the test chose. */
  class ChoosingResolver extends BusConflictResolver {
    asked: string[] = [];
    constructor(bus: EventBus, private readonly reply: ConflictAnswer) {
      super(bus);
    }
    protected async ask(request: ConflictRequest): Promise<ConflictAnswer> {
      this.asked.push(request.question);
      return this.reply;
    }
  }

  async function planningSetup(answer: ConflictAnswer, plan: string) {
    const dir = await makeTempRepo();
    const repo = new RepoManager(dir);
    await repo.openOrInit();
    const store = new EventStore(repo.paths.dbFile);
    onCleanup(() => store.close());
    onCleanup(() => safeRemove(dir));
    const bus = new EventBus(store);
    const conflicts = new ChoosingResolver(bus, answer);

    // The worker writes a file per task so each one commits something.
    const worker = new StubAdapter({ writes: { "notes-{agent}.txt": "done {agent}\n" } });
    // Both in one registry: the workers resolve "claude-code" and the
    // Operator resolves its own tool to do the planning.
    const registry = new AdapterRegistry().register(worker).register(planningAdapter(plan));

    const operator = new Operator({
      repo,
      registry,
      bus,
      queue: new TaskQueue(store.database),
      conflicts,
      workers: [profile("worker-a"), profile("worker-b")],
      operator: profile("operator", { tool: "copilot-cli" }),
    });
    return { operator, conflicts, registry, repo, store };
  }

  it("asks before running a split, and runs what was agreed", async () => {
    const { operator, conflicts } = await planningSetup(
      { chosen: "accept", custom: false },
      "TASK: write the parser\nTASK: write the docs\nNOTE: different files",
    );

    const report = await operator.planAndRun("add CSV support and document it");

    // The plan was put to the person, with both tasks in it.
    expect(conflicts.asked).toHaveLength(1);
    expect(conflicts.asked[0]).toContain("write the parser");
    expect(conflicts.asked[0]).toContain("write the docs");
    expect(report.outcomes.map((o) => o.task.instruction)).toEqual([
      "write the parser",
      "write the docs",
    ]);
  });

  it("runs the request whole when that is what was chosen", async () => {
    const { operator } = await planningSetup(
      { chosen: "single", custom: false },
      "TASK: write the parser\nTASK: write the docs",
    );

    const report = await operator.planAndRun("add CSV support and document it");
    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]?.task.instruction).toBe("add CSV support and document it");
  });

  it("takes the person's own words over the plan", async () => {
    const { operator } = await planningSetup(
      { chosen: "just update the README", custom: true },
      "TASK: write the parser\nTASK: write the docs",
    );

    const report = await operator.planAndRun("add CSV support");
    expect(report.outcomes.map((o) => o.task.instruction)).toEqual(["just update the README"]);
  });

  it("does not ask when there was no plan to agree to", async () => {
    const dir = await makeTempRepo();
    const repo = new RepoManager(dir);
    await repo.openOrInit();
    const store = new EventStore(repo.paths.dbFile);
    onCleanup(() => store.close());
    onCleanup(() => safeRemove(dir));
    const bus = new EventBus(store);
    const conflicts = new ChoosingResolver(bus, { chosen: "accept", custom: false });

    // No operator profile, so nothing can plan.
    const operator = new Operator({
      repo,
      registry: new AdapterRegistry().register(new StubAdapter({ writes: { "a.txt": "x" } })),
      bus,
      queue: new TaskQueue(store.database),
      conflicts,
      workers: [profile("worker-a")],
    });

    const report = await operator.planAndRun("do the thing");
    expect(conflicts.asked).toHaveLength(0);
    expect(report.outcomes.map((o) => o.task.instruction)).toEqual(["do the thing"]);
  });
});

describe("Operator work distribution", () => {
  /** Records overlap per agent and takes a configurable time per task. */
  class PacedAdapter implements AgentAdapter {
    readonly id = "claude-code" as const;
    readonly displayName = "Paced";
    readonly capabilities = { streaming: false, structuredOutput: false, resumable: false };
    readonly runs: Array<{ agentId: string; task: string; start: number; end: number }> = [];

    constructor(private readonly durations: Record<string, number>) {}

    async check(): Promise<AdapterHealth> {
      return { installed: true, authenticated: true };
    }

    async start(options: AgentRunOptions): Promise<AgentHandle> {
      const runs = this.runs;
      const task = options.prompt.split("\n")[0] ?? "";
      const wait = this.durations[task.trim()] ?? 20;
      return {
        agentId: options.agentId,
        onEvent: () => () => {},
        waitForCompletion: async () => {
          const start = Date.now();
          await new Promise((resolve) => setTimeout(resolve, wait));
          runs.push({ agentId: options.agentId, task: task.trim(), start, end: Date.now() });
          return { ok: true, stalled: false };
        },
        interrupt: async () => {},
        kill: async () => {},
      };
    }
  }

  it("does not leave a worker idle while another holds a queue", async () => {
    // Dealing round-robin gave worker-a positions 0 and 2 — "slow" and
    // "third" — so the third task waited behind the slow one even though the
    // other worker was free. Pulling from a shared queue, whoever finishes
    // first takes it.
    //
    // Asserted structurally rather than on timings: creating a git worktree
    // takes seconds on Windows and swamps any wall-clock comparison.
    const adapter = new PacedAdapter({ slow: 3000, quick: 10, third: 10 });
    const { operator } = await setup(adapter, [profile("worker-a"), profile("worker-b")]);

    await operator.run(["slow", "quick", "third"]);

    const ranSlow = adapter.runs.find((run) => run.task === "slow")?.agentId;
    const ranThird = adapter.runs.find((run) => run.task === "third")?.agentId;
    expect(ranSlow).toBeDefined();
    expect(ranThird).toBeDefined();
    expect(ranThird).not.toBe(ranSlow);
  });

  it("still gives each task to exactly one worker", async () => {
    const adapter = new PacedAdapter({});
    const { operator } = await setup(adapter, [profile("worker-a"), profile("worker-b")]);

    const report = await operator.run(["one", "two", "three", "four"]);

    expect(report.outcomes.map((outcome) => outcome.task.summary)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
    expect(adapter.runs).toHaveLength(4);
  });
});
