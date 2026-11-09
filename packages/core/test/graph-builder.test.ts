import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import { assignLanes, buildGraph } from "../src/git/graph-builder.js";
import { buildFileTree } from "../src/git/file-tree.js";
import { makeTempRepo, onCleanup, runCleanups, safeRemove } from "./helpers.js";

afterEach(runCleanups);

async function repoWithBranches() {
  const dir = await makeTempRepo();
  onCleanup(() => safeRemove(dir));
  const git = simpleGit(dir);

  const commit = async (file: string, body: string, message: string) => {
    writeFileSync(join(dir, file), body, "utf8");
    await git.add(["-A"]);
    await git.commit(message);
  };

  await commit("a.txt", "one", "first");
  await git.checkoutBranch("maya/t1/worker-a", "main");
  await commit("b.txt", "two", "worker a work");
  await git.checkout("main");
  await commit("c.txt", "three", "main moves on");
  await git.raw(["merge", "--no-ff", "maya/t1/worker-a", "-m", "merge worker a"]);

  return { dir, git };
}

describe("buildGraph", () => {
  it("returns every commit with its parents, refs and current branch", async () => {
    const { git } = await repoWithBranches();
    const graph = await buildGraph(git);

    const subjects = graph.nodes.map((node) => node.subject);
    expect(subjects).toContain("merge worker a");
    expect(subjects).toContain("worker a work");
    expect(subjects).toContain("main moves on");

    expect(graph.currentBranch).toBe("main");
    expect(graph.head).toMatch(/^[0-9a-f]{40}$/);

    const merge = graph.nodes.find((node) => node.subject === "merge worker a");
    expect(merge?.parents).toHaveLength(2);
    expect(merge?.sha).toBe(graph.head);
    expect(merge?.refs.join(" ")).toContain("main");

    const onBranch = graph.nodes.find((node) => node.subject === "worker a work");
    expect(onBranch?.refs.join(" ")).toContain("maya/t1/worker-a");
  });

  it("agrees with `git log --graph` on the order and the commit set", async () => {
    const { git } = await repoWithBranches();
    const graph = await buildGraph(git);

    // The same walk git itself draws, so the tree cannot disagree with the
    // repository it claims to show.
    const native = await git.raw([
      "log",
      "--all",
      "--topo-order",
      "--pretty=format:%H",
    ]);
    expect(graph.nodes.map((node) => node.sha)).toEqual(
      native.split("\n").filter((line) => line.trim() !== ""),
    );
  });

  it("honours the commit limit", async () => {
    const { git } = await repoWithBranches();
    const graph = await buildGraph(git, { limit: 2 });
    expect(graph.nodes).toHaveLength(2);
  });

  it("survives a repository with no commits", async () => {
    const dir = await makeTempRepo();
    onCleanup(() => safeRemove(dir));
    const git = simpleGit(dir);
    await git.raw(["checkout", "--orphan", "fresh"]);
    await git.raw(["update-ref", "-d", "refs/heads/main"]);

    const graph = await buildGraph(git);
    expect(graph.nodes).toEqual([]);
    expect(graph.head).toBeNull();
  });
});

describe("assignLanes", () => {
  const commit = (sha: string, parents: string[]) => ({
    sha,
    parents,
    subject: sha,
    author: "a",
    date: "2026-01-01T00:00:00Z",
    refs: [],
  });

  it("keeps a straight history in one lane", () => {
    const lanes = assignLanes([
      commit("c", ["b"]),
      commit("b", ["a"]),
      commit("a", []),
    ]);
    expect(lanes.map((node) => node.lane)).toEqual([0, 0, 0]);
  });

  it("gives a merge's second parent a lane of its own, and frees it after", () => {
    //   m        lane 0, parents main-side `c` and branch-side `b`
    //   |\
    //   c |      lane 0
    //   | b      lane 1
    //   |/
    //   a        back to lane 0 once the branch has been accounted for
    const lanes = assignLanes([
      commit("m", ["c", "b"]),
      commit("c", ["a"]),
      commit("b", ["a"]),
      commit("a", []),
    ]);
    expect(lanes.map((node) => `${node.sha}:${node.lane}`)).toEqual([
      "m:0",
      "c:0",
      "b:1",
      "a:0",
    ]);
  });

  it("puts two unrelated tips in separate lanes", () => {
    const lanes = assignLanes([commit("x", []), commit("y", [])]);
    expect(lanes.map((node) => node.lane)).toEqual([0, 0]);
  });

  it("does not leave a lane held by a branch that already converged", () => {
    // Two tips over a shared base: the base must come back to lane 0 rather
    // than drifting right, which is what an unreleased lane looks like.
    const lanes = assignLanes([
      commit("t1", ["base"]),
      commit("t2", ["base"]),
      commit("base", []),
    ]);
    expect(lanes.map((node) => node.lane)).toEqual([0, 1, 0]);
  });
});

describe("buildFileTree", () => {
  it("nests tracked and untracked files, directories first", async () => {
    const dir = await makeTempRepo();
    onCleanup(() => safeRemove(dir));
    const git = simpleGit(dir);

    writeFileSync(join(dir, "README.md"), "hi", "utf8");
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\nnode_modules/\n", "utf8");
    writeFileSync(join(dir, "ignored.txt"), "no", "utf8");
    await git.raw(["init", "-q"]).catch(() => undefined);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "x", "utf8");
    writeFileSync(join(dir, "src", "deep", "leaf.ts"), "y", "utf8");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "junk.js"), "z", "utf8");
    await git.add(["README.md"]);
    await git.commit("add readme");

    const tree = await buildFileTree(git);
    const names = tree.root.children?.map((child) => child.name) ?? [];

    // Directories first, then files, each alphabetical.
    expect(names[0]).toBe("src");
    expect(names).toContain("README.md");
    expect(names).toContain(".gitignore");

    // What .gitignore excludes is not part of the project the user sees.
    expect(names).not.toContain("ignored.txt");
    expect(names).not.toContain("node_modules");

    const src = tree.root.children?.find((child) => child.name === "src");
    expect(src?.type).toBe("dir");
    const deep = src?.children?.find((child) => child.name === "deep");
    expect(deep?.children?.[0]?.path).toBe("src/deep/leaf.ts");
  });
});
