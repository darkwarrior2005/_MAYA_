import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "../src/bus/event-store.js";
import { MayaPaths, defaultConfig, type AdapterPlugin } from "../src/config/maya-config.js";
import { loadRegistry } from "../src/adapters/build-registry.js";
import { loadAdapterPlugins } from "../src/adapters/plugin-loader.js";
import { recoverSession, describeRecovery } from "../src/daemon/recovery.js";
import { TaskQueue } from "../src/orchestrator/task-queue.js";
import { makeTempRepo, onCleanup, runCleanups, safeRemove } from "./helpers.js";

afterEach(runCleanups);

/** A plugin on disk, as a project would actually ship one. */
function writePlugin(dir: string, name: string, source: string): string {
  mkdirSync(join(dir, "plugins"), { recursive: true });
  const file = join(dir, "plugins", name);
  writeFileSync(file, source, "utf8");
  return `./plugins/${name}`;
}

const GOOD_PLUGIN = `
export function createAdapter(options) {
  return {
    id: "my-tool",
    displayName: "My Tool",
    capabilities: { streaming: true, structuredOutput: false, resumable: false },
    greeting: options.greeting,
    async check() {
      return { installed: true, authenticated: true, detail: "stub" };
    },
    async start() {
      throw new Error("not used in this test");
    },
  };
}
`;

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "maya-plugin-"));
  onCleanup(() => safeRemove(dir));
  return dir;
}

const context = (repoRoot: string) => ({
  repoRoot,
  rawLogPath: (agentId: string) => join(repoRoot, `${agentId}.ndjson`),
});

describe("adapter plugins", () => {
  it("loads an adapter the project points at, and passes its options", async () => {
    const dir = project();
    const module = writePlugin(dir, "my-tool.mjs", GOOD_PLUGIN);
    const plugin: AdapterPlugin = {
      id: "my-tool",
      module,
      export: "createAdapter",
      options: { greeting: "hello" },
    };

    const announced: string[] = [];
    const { loaded, problems } = await loadAdapterPlugins([plugin], context(dir), (line) =>
      announced.push(line),
    );

    expect(problems).toEqual([]);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.displayName).toBe("My Tool");
    expect((loaded[0] as unknown as { greeting: string }).greeting).toBe("hello");
    // Loading a plugin runs its code, so it is never silent.
    expect(announced[0]).toContain("my-tool.mjs");
  });

  it("registers it alongside the built-in adapters", async () => {
    const dir = project();
    const module = writePlugin(dir, "my-tool.mjs", GOOD_PLUGIN);
    const paths = new MayaPaths(dir);
    const config = {
      ...defaultConfig(),
      adapters: [{ id: "my-tool", module, export: "createAdapter" }],
    };

    const { registry, problems } = await loadRegistry(paths, config);
    expect(problems).toEqual([]);
    expect(registry.has("my-tool")).toBe(true);
    expect(registry.has("claude-code")).toBe(true);
    expect(registry.get("my-tool").displayName).toBe("My Tool");
  });

  it("reports a broken plugin instead of taking the session down with it", async () => {
    const dir = project();
    const cases: Array<[string, AdapterPlugin, string]> = [
      [
        "a module that does not exist",
        { id: "missing", module: "./plugins/not-here.mjs" },
        "missing",
      ],
      [
        "a module with no matching export",
        { id: "no-export", module: writePlugin(dir, "no-export.mjs", "export const x = 1;") },
        "no default export",
      ],
      [
        "a factory that throws",
        {
          id: "throws",
          module: writePlugin(dir, "throws.mjs", "export default () => { throw new Error('boom'); };"),
        },
        "boom",
      ],
      [
        "something that is not an adapter",
        { id: "not-adapter", module: writePlugin(dir, "wrong.mjs", "export default () => ({});") },
        "missing id",
      ],
      [
        "an adapter whose id disagrees with the config",
        {
          id: "declared-as-this",
          module: writePlugin(
            dir,
            "mismatch.mjs",
            `export default () => ({ id: "but-i-am-this", displayName: "X", capabilities: {}, check() {}, start() {} });`,
          ),
        },
        'registered itself as "but-i-am-this"',
      ],
    ];

    for (const [name, plugin, expected] of cases) {
      const { loaded, problems } = await loadAdapterPlugins([plugin], context(dir));
      expect(loaded, name).toHaveLength(0);
      expect(problems.join(" "), name).toContain(expected);
    }
  });

  it("loads nothing when a project has configured nothing", async () => {
    const dir = project();
    const { registry, problems } = await loadRegistry(new MayaPaths(dir), defaultConfig());
    expect(problems).toEqual([]);
    expect(registry.all().map((adapter) => adapter.id).sort()).toEqual([
      "antigravity-cli",
      "claude-code",
      "copilot-cli",
    ]);
  });
});

describe("recovering from a daemon that did not shut down", () => {
  async function crashedSession() {
    const repoRoot = await makeTempRepo();
    onCleanup(() => safeRemove(repoRoot));
    const paths = new MayaPaths(repoRoot);
    paths.ensureDirs();
    const store = new EventStore(paths.dbFile);
    onCleanup(() => store.close());
    return { repoRoot, paths, store, git: simpleGit(repoRoot) };
  }

  it("clears a lock whose process is gone", async () => {
    const { paths, store, git } = await crashedSession();
    writeFileSync(
      paths.lockFile,
      JSON.stringify({ pid: 999_999, port: 1234, startedAt: new Date().toISOString() }),
      "utf8",
    );

    const report = await recoverSession({ paths, git, store });
    expect(report.clearedStaleLock).toBe(999_999);
    expect(describeRecovery(report).join(" ")).toContain("stale daemon lock");
  });

  it("leaves a live daemon's lock alone", async () => {
    const { paths, store, git } = await crashedSession();
    writeFileSync(
      paths.lockFile,
      JSON.stringify({ pid: process.pid, port: 1234, startedAt: new Date().toISOString() }),
      "utf8",
    );

    const report = await recoverSession({ paths, git, store });
    expect(report.clearedStaleLock).toBeNull();
  });

  it("stops claiming that work from a dead process is still running", async () => {
    const { paths, store, git } = await crashedSession();
    const queue = new TaskQueue(store.database);
    const running = queue.add("mid-flight", "mid-flight");
    queue.assign(running.id, "worker-a", "maya/x/worker-a");
    queue.setState(running.id, "running");
    const merged = queue.add("already done", "already done");
    queue.setState(merged.id, "merged");

    const report = await recoverSession({ paths, git, store });

    expect(report.orphanedTasks.map((task) => task.summary)).toEqual(["mid-flight"]);
    expect(queue.get(running.id)?.state).toBe("blocked");
    // Finished work is not touched.
    expect(queue.get(merged.id)?.state).toBe("merged");
  });

  it("reports a leftover worktree rather than deleting what may be in it", async () => {
    const { repoRoot, paths, store, git } = await crashedSession();
    const worktree = join(paths.stateDir, "worktrees", "t1-worker-a");
    await git.raw(["worktree", "add", "-b", "maya/t1/worker-a", worktree, "main"]);
    // Work the crashed agent never got to commit.
    writeFileSync(join(worktree, "unsaved.txt"), "do not lose me", "utf8");

    const report = await recoverSession({ paths, git, store });

    expect(report.leftoverWorktrees).toHaveLength(1);
    expect(describeRecovery(report).join(" ")).toContain("may hold uncommitted work");
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(worktree, "unsaved.txt"))).toBe(true);
    expect(repoRoot).toBeTruthy();
  });

  it("says nothing after a clean shutdown", async () => {
    const { paths, store, git } = await crashedSession();
    const report = await recoverSession({ paths, git, store });
    expect(describeRecovery(report)).toEqual([]);
  });
});
