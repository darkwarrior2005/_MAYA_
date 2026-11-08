import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentDescriptor } from "@maya/shared-types";
import { EventBus } from "../src/bus/event-bus.js";
import { EventStore } from "../src/bus/event-store.js";
import { RepoManager } from "../src/git/repo-manager.js";
import { MergeService } from "../src/git/merge-service.js";
import { TaskRunner } from "../src/orchestrator/task-runner.js";
import { makeTempRepo, onCleanup, runCleanups, safeRemove, StubAdapter } from "./helpers.js";

const agent: AgentDescriptor = {
  id: "worker-1",
  role: "worker",
  tool: "claude-code",
  displayName: "Stub Worker",
};

afterEach(runCleanups);

async function setup(adapter: StubAdapter) {
  const dir = await makeTempRepo();
  const repo = new RepoManager(dir);
  await repo.openOrInit();
  const store = new EventStore(repo.paths.dbFile);
  onCleanup(() => store.close());
  onCleanup(() => safeRemove(dir));
  const bus = new EventBus(store);
  return { dir, repo, store, runner: new TaskRunner(repo, adapter, bus) };
}

describe("TaskRunner", () => {
  it("branches, commits the agent's work, snapshots context, and merges into main", async () => {
    const adapter = new StubAdapter({ writes: { "feature.txt": "hello from the agent\n" } });
    const { dir, repo, store, runner } = await setup(adapter);

    const outcome = await runner.run({ instruction: "add a feature file", agent });

    expect(outcome.ok).toBe(true);
    expect(outcome.merged).toBe(true);
    expect(outcome.committed).toBeTruthy();
    expect(outcome.branch).toBe(`maya/${outcome.taskId}/worker-1`);

    // work landed on main
    const log = await simpleGit(dir).log();
    expect(log.all.some((c) => c.message.includes("add a feature file"))).toBe(true);
    expect(readFileSync(join(dir, "feature.txt"), "utf8")).toContain("hello from the agent");

    // context snapshots exist in both formats
    const agentDir = repo.paths.agentDir("worker-1");
    expect(existsSync(join(agentDir, "latest.md"))).toBe(true);
    expect(existsSync(join(agentDir, "latest.html"))).toBe(true);

    // chat log recorded the lifecycle
    const types = store.since(0).map((e) => e.type);
    expect(types).toContain("task_assigned");
    expect(types).toContain("merge_result");
    expect(types).toContain("task_completed");

  });

  it("leaves work on its branch and never merges when the agent fails", async () => {
    const adapter = new StubAdapter({ ok: false, writes: { "partial.txt": "half done\n" } });
    const { dir, runner } = await setup(adapter);

    const outcome = await runner.run({ instruction: "do something broken", agent });

    expect(outcome.ok).toBe(false);
    expect(outcome.merged).toBe(false);
    expect(existsSync(join(dir, "partial.txt"))).toBe(false); // back on main, work isolated

  });

  it("does not merge a stalled agent's work", async () => {
    const adapter = new StubAdapter({ hang: true });
    const { runner } = await setup(adapter);

    const outcome = await runner.run({
      instruction: "hang forever",
      agent,
      stallTimeoutSec: 0.2,
    });

    expect(outcome.stalled).toBe(true);
    expect(outcome.merged).toBe(false);
    expect(adapter.killed).toBe(true);

  });
});

describe("MergeService", () => {
  it("refuses a conflicting merge, aborts it, and reports the conflicted files", async () => {
    const dir = await makeTempRepo();
    onCleanup(() => safeRemove(dir));
    const git = simpleGit(dir);

    writeFileSync(join(dir, "shared.txt"), "base\n");
    await git.add(["-A"]);
    await git.commit("base file");

    await git.checkoutBranch("maya/t1/worker-a", "main");
    writeFileSync(join(dir, "shared.txt"), "worker A version\n");
    await git.add(["-A"]);
    await git.commit("A edits shared");

    await git.checkout("main");
    writeFileSync(join(dir, "shared.txt"), "main version\n");
    await git.add(["-A"]);
    await git.commit("main edits shared");

    const outcome = await new MergeService(git).mergeTaskBranch("maya/t1/worker-a", "main");

    expect(outcome.merged).toBe(false);
    expect(outcome.conflicts).toContain("shared.txt");
    expect(outcome.abortedCleanly).toBe(true);

    // the tree must be clean again, not left mid-merge
    expect((await git.status()).isClean()).toBe(true);
    expect(readFileSync(join(dir, "shared.txt"), "utf8")).toBe("main version\n");
  });
});
