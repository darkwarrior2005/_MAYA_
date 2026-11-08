import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
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

async function setup(adapter: StubAdapter, workers: WorkerProfile[]) {
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
