import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
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
import { HoldOnConflictResolver } from "../src/orchestrator/conflict-resolver.js";
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
