import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import { describeBadPermission } from "../src/adapters/copilot-cli.js";
import { EventBus } from "../src/bus/event-bus.js";
import { EventStore } from "../src/bus/event-store.js";
import { MayaPaths } from "../src/config/maya-config.js";
import { isAllowedHost, isAllowedOrigin } from "../src/daemon/origin.js";
import { describeRecovery, recoverSession } from "../src/daemon/recovery.js";
import { buildFileTree } from "../src/git/file-tree.js";
import { BranchManager } from "../src/git/branch-manager.js";
import { RepoManager } from "../src/git/repo-manager.js";
import { splitSecretLines } from "../src/orchestrator/secret-channel.js";
import { makeTempRepo, onCleanup, runCleanups, safeRemove } from "./helpers.js";

afterEach(runCleanups);

describe("the state directory ignores itself", () => {
  it("writes .maya/.gitignore the moment the directory exists", async () => {
    const root = await makeTempRepo();
    onCleanup(() => safeRemove(root));
    const paths = new MayaPaths(root);

    // Nothing else is called — no `maya init`, no excludeStateDirFromGit.
    paths.ensureDirs();

    expect(readFileSync(join(paths.stateDir, ".gitignore"), "utf8").trim()).toBe("*");
    // Which is what keeps the tree clean, and therefore mergeable, in any
    // code path that only creates the directory.
    const status = await simpleGit(root).status();
    expect(status.not_added.filter((path) => path.startsWith(".maya"))).toEqual([]);
  });
});

describe("Copilot permission patterns are checked before spending a credit", () => {
  it("accepts the shapes Copilot understands", () => {
    for (const pattern of ["write", "write(src/**)", "shell(git:*)", "read", "mcp(server)"]) {
      expect(describeBadPermission(pattern), pattern).toBeNull();
    }
  });

  it("rejects an internal tool name, which silently grants nothing", () => {
    const problem = describeBadPermission("apply_patch");
    expect(problem).toContain("not a Copilot permission kind");
  });

  it("rejects a malformed pattern", () => {
    expect(describeBadPermission("shell(")).toContain("not a permission pattern");
    expect(describeBadPermission("")).toContain("not a permission pattern");
  });
});

describe("the secret marker does not fire on code", () => {
  it("still catches a real message", () => {
    expect(splitSecretLines("@user which encoding?").secret).toEqual(["which encoding?"]);
    expect(splitSecretLines("@user: which encoding?").secret).toEqual(["which encoding?"]);
  });

  it("leaves a Python property decorator alone", () => {
    // `@user.setter` is ordinary code, not a message to the person.
    const text = "@user.setter\ndef user(self, value):\n    self._user = value";
    expect(splitSecretLines(text).secret).toEqual([]);
    expect(splitSecretLines(text).main).toBe(text);
  });

  it("leaves a bare tag and a decorator with arguments alone", () => {
    expect(splitSecretLines("@user_required").secret).toEqual([]);
    expect(splitSecretLines("@user(role='admin')").secret).toEqual([]);
    expect(splitSecretLines("@user").secret).toEqual([]);
  });

  it("ignores the marker inside a fenced code block", () => {
    const text = ["Here is the fix:", "```python", "@user her", "```", "Done."].join("\n");
    expect(splitSecretLines(text).secret).toEqual([]);
    expect(splitSecretLines(text).main).toContain("@user her");
  });
});

describe("the daemon checks where a request arrived", () => {
  it("accepts its own loopback host", () => {
    expect(isAllowedHost("127.0.0.1:7777", 7777)).toBe(true);
    expect(isAllowedHost("localhost:7777", 7777)).toBe(true);
    expect(isAllowedHost("[::1]:7777", 7777)).toBe(true);
  });

  it("refuses a rebound hostname, which Origin alone does not catch", () => {
    // A domain the attacker points at 127.0.0.1: the browser thinks the page
    // and the daemon are same-origin, so Origin looks fine to them both.
    expect(isAllowedHost("evil.example:7777", 7777)).toBe(false);
    expect(isAllowedHost("maya.attacker.test:7777", 7777)).toBe(false);
    expect(isAllowedHost(undefined, 7777)).toBe(false);
  });

  it("refuses a host naming another port", () => {
    expect(isAllowedHost("127.0.0.1:9999", 7777)).toBe(false);
  });

  it("still allows a tool that sends no Origin", () => {
    expect(isAllowedOrigin(undefined, 7777)).toBe(true);
  });
});

describe("the file tree does not show files that are gone", () => {
  it("leaves out a tracked file deleted from disk", async () => {
    const root = await makeTempRepo();
    onCleanup(() => safeRemove(root));
    const git = simpleGit(root);
    writeFileSync(join(root, "keep.ts"), "export const a = 1;\n", "utf8");
    writeFileSync(join(root, "gone.ts"), "export const b = 2;\n", "utf8");
    await git.add(["-A"]);
    await git.commit("add both");

    rmSync(join(root, "gone.ts"));

    const tree = await buildFileTree(git);
    const names = (tree.root.children ?? []).map((child) => child.name);
    expect(names).toContain("keep.ts");
    // `--cached` reads the index, so this used to be listed as if it existed.
    expect(names).not.toContain("gone.ts");
  });
});

describe("the staged diff is taken against the base", () => {
  it("includes a commit the agent made during its own run", async () => {
    const root = await makeTempRepo();
    onCleanup(() => safeRemove(root));
    const git = simpleGit(root);
    const branches = new BranchManager(git);

    await git.raw(["checkout", "-b", "maya/t1/worker-a"]);
    // The agent commits once itself, then leaves more uncommitted.
    writeFileSync(join(root, "first.ts"), "export const a = 1;\n", "utf8");
    await git.add(["-A"]);
    await git.commit("the agent's own commit");
    writeFileSync(join(root, "second.ts"), "export const b = 2;\n", "utf8");
    await branches.stageAll();

    const againstHead = await branches.stagedDiffStat();
    const againstBase = await branches.stagedDiffStat("main");

    expect(againstHead).toContain("second.ts");
    expect(againstHead).not.toContain("first.ts");
    // The summary describes the whole branch, not just the last edit.
    expect(againstBase).toContain("second.ts");
    expect(againstBase).toContain("first.ts");
  });
});

describe("a question nobody can answer is closed", () => {
  it("cancels a conflict_prompt the dead Operator left behind", async () => {
    const root = await makeTempRepo();
    onCleanup(() => safeRemove(root));
    const paths = new MayaPaths(root);
    paths.ensureDirs();
    const store = new EventStore(paths.dbFile);
    onCleanup(() => store.close());
    const bus = new EventBus(store);

    bus.publish("main", null, "conflict_prompt", {
      type: "conflict_prompt",
      promptId: "ghost",
      question: "which branch wins?",
      options: [{ id: "hold", label: "Keep it" }],
    });

    const report = await recoverSession({ paths, git: simpleGit(root), store, bus });

    expect(report.cancelledQuestions).toBe(1);
    expect(describeRecovery(report).join(" ")).toContain("nobody left to answer");

    // A view deriving the open question from the log now sees it resolved,
    // instead of showing it forever in every future session.
    const resolved = store
      .since(0)
      .filter((event) => event.payload.type === "conflict_resolved");
    expect(resolved).toHaveLength(1);
  });

  it("leaves an answered question alone", async () => {
    const root = await makeTempRepo();
    onCleanup(() => safeRemove(root));
    const paths = new MayaPaths(root);
    paths.ensureDirs();
    const store = new EventStore(paths.dbFile);
    onCleanup(() => store.close());
    const bus = new EventBus(store);

    bus.publish("main", null, "conflict_prompt", {
      type: "conflict_prompt",
      promptId: "p1",
      question: "which?",
      options: [],
    });
    bus.publish("main", null, "conflict_resolved", {
      type: "conflict_resolved",
      promptId: "p1",
      chosen: "hold",
      custom: false,
    });

    const report = await recoverSession({ paths, git: simpleGit(root), store, bus });
    expect(report.cancelledQuestions).toBe(0);
  });
});

describe("a temp directory is never left behind by these tests", () => {
  it("keeps the scratch root tidy", () => {
    const dir = mkdtempSync(join(tmpdir(), "maya-tidy-"));
    safeRemove(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("git with no identity configured", () => {
  // The first CI run that got past setup failed here, on Linux: a fresh
  // runner has no user.name or user.email, every `git commit` on it fails
  // with "Please tell me who you are", and `maya init` makes an empty first
  // commit. The harness then read .maya/config.json and died with ENOENT
  // three steps away from the cause.
  //
  // `GIT_CONFIG_GLOBAL=/dev/null` is how that machine is reproduced on one
  // that does have an identity: it hides the user's global config from git
  // without touching it.
  function blankConfig(): Record<string, string> {
    return {
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
  }

  it("reports that it cannot commit, rather than letting git fail later", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maya-noident-"));
    onCleanup(() => safeRemove(dir));

    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(blankConfig())) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      // One call, both assertions: the first `openOrInit` leaves the repo
      // created, so a second one skips the identity check and throws nothing.
      const failure = await new RepoManager(dir).openOrInit().then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(failure).toMatch(/user\.name or user\.email/);
      // And it says what to run, because "it failed" is not useful on a
      // machine the person has only just set up.
      expect(failure).toMatch(/git config --global/);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("says yes on a repository that does have one", async () => {
    const dir = await makeTempRepo();
    expect(await new RepoManager(dir).hasIdentity()).toBe(true);
  });
});
