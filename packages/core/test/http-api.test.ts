import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";
import type { BusEvent, GitGraph, TaskSpec } from "@maya/shared-types";
import { EventBus } from "../src/bus/event-bus.js";
import { EventStore } from "../src/bus/event-store.js";
import { MayaPaths, defaultConfig, excludeStateDirFromGit } from "../src/config/maya-config.js";
import { Daemon } from "../src/daemon/server.js";
import { resolveWithin } from "../src/daemon/http-api.js";
import type { RepoTree } from "../src/git/file-tree.js";
import { makeTempRepo, onCleanup, runCleanups, safeRemove } from "./helpers.js";

afterEach(runCleanups);

async function serve(options: { withClient?: boolean } = {}) {
  const repoRoot = await makeTempRepo();
  const git = simpleGit(repoRoot);
  writeFileSync(join(repoRoot, "README.md"), "# project\n", "utf8");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "index.ts"), "export {};\n", "utf8");
  await git.add(["-A"]);
  await git.commit("add sources");

  const paths = new MayaPaths(repoRoot);
  paths.ensureDirs();
  // `maya init` does this; without it the state dir itself shows up as an
  // untracked change and the session reports a dirty tree.
  excludeStateDirFromGit(repoRoot);
  const store = new EventStore(paths.dbFile);
  const bus = new EventBus(store);

  let clientDir: string | undefined;
  if (options.withClient) {
    clientDir = mkdtempSync(join(tmpdir(), "maya-client-"));
    writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>Maya</title>", "utf8");
    writeFileSync(join(clientDir, "app.js"), "console.log('maya')", "utf8");
    mkdirSync(join(clientDir, "assets"), { recursive: true });
    writeFileSync(join(clientDir, "assets", "style.css"), "body{}", "utf8");
  }

  const daemon = new Daemon({
    paths,
    bus,
    store,
    web: {
      repoRoot,
      git,
      store,
      bus,
      config: defaultConfig(),
      ...(clientDir ? { clientDir } : {}),
    },
  });
  await daemon.start();

  onCleanup(() => {
    void daemon.stop();
    store.close();
    safeRemove(repoRoot);
    if (clientDir) safeRemove(clientDir);
  });

  const get = async (path: string): Promise<Response> => fetch(`${daemon.address}${path}`);
  return { daemon, bus, store, repoRoot, get, clientDir };
}

describe("the daemon's HTTP API", () => {
  it("describes the session", async () => {
    const { get, repoRoot } = await serve();
    const body = (await (await get("/api/session")).json()) as Record<string, unknown>;

    expect(body["repoRoot"]).toBe(repoRoot);
    expect(body["branch"]).toBe("main");
    expect(body["clean"]).toBe(true);
    expect((body["workers"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("serves the commit graph the git tree draws", async () => {
    const { get } = await serve();
    const graph = (await (await get("/api/graph")).json()) as GitGraph;

    expect(graph.currentBranch).toBe("main");
    expect(graph.nodes.map((node) => node.subject)).toContain("add sources");
    expect(graph.nodes.every((node) => typeof node.lane === "number")).toBe(true);
  });

  it("serves the repository tree", async () => {
    const { get } = await serve();
    const tree = (await (await get("/api/files")).json()) as RepoTree;

    const names = tree.root.children?.map((child) => child.name) ?? [];
    expect(names).toContain("src");
    expect(names).toContain("README.md");
    expect(tree.fileCount).toBeGreaterThan(0);
  });

  it("replays events from a given id", async () => {
    const { get, bus } = await serve();
    const first = bus.publish("main", "a", "text", { type: "text", agentId: "a", text: "one" });
    bus.publish("main", "a", "text", { type: "text", agentId: "a", text: "two" });

    const all = (await (await get("/api/events?since=0")).json()) as BusEvent[];
    expect(all).toHaveLength(2);

    const rest = (await (await get(`/api/events?since=${first.id}`)).json()) as BusEvent[];
    expect(rest).toHaveLength(1);
    expect((rest[0]?.payload as { text: string }).text).toBe("two");
  });

  it("lists tasks for the agents-to-do panel", async () => {
    const { get, store } = await serve();
    const { TaskQueue } = await import("../src/orchestrator/task-queue.js");
    new TaskQueue(store.database).add("do a thing", "do a thing properly");

    const tasks = (await (await get("/api/tasks")).json()) as TaskSpec[];
    expect(tasks.map((task) => task.summary)).toEqual(["do a thing"]);
  });

  it("puts a message from the web onto the same bus the CLI reads", async () => {
    const { daemon, bus } = await serve();
    const seen: string[] = [];
    bus.subscribe((event) => {
      if (event.payload.type === "user_message") seen.push(event.payload.text);
    });

    const response = await fetch(`${daemon.address}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "add a README" }),
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual(["add a README"]);
  });

  it("rejects a message with no text rather than publishing an empty one", async () => {
    const { daemon } = await serve();
    const response = await fetch(`${daemon.address}/api/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   " }),
    });
    expect(response.status).toBe(400);
  });

  it("answers 404 for an unknown api route", async () => {
    const { get } = await serve();
    expect((await get("/api/nope")).status).toBe(404);
  });

  it("says what to do when the client has not been built", async () => {
    const { get } = await serve();
    const response = await get("/");
    expect(response.status).toBe(503);
    expect(((await response.json()) as { hint: string }).hint).toContain("pnpm build");
  });
});

describe("serving the web client", () => {
  it("serves the app shell and its assets with sensible types", async () => {
    const { get } = await serve({ withClient: true });

    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Maya");

    const script = await get("/app.js");
    expect(script.headers.get("content-type")).toContain("text/javascript");

    const style = await get("/assets/style.css");
    expect(style.status).toBe(200);
    expect(style.headers.get("content-type")).toContain("text/css");
  });

  it("falls back to the app shell so a client route survives a reload", async () => {
    const { get } = await serve({ withClient: true });
    const deep = await get("/some/client/route");
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain("Maya");
  });

  it("does not serve a file outside the client directory", async () => {
    const { get } = await serve({ withClient: true });
    // Anything that escapes falls through to the app shell rather than
    // reaching the filesystem; the server is reachable by anything on the
    // machine, so this must not depend on the browser normalising the path.
    for (const attempt of [
      "/../../../../Windows/win.ini",
      "/..%2f..%2f..%2fetc%2fpasswd",
      "/%2e%2e/%2e%2e/secrets.txt",
    ]) {
      const response = await get(attempt);
      const body = await response.text();
      expect(body).toContain("Maya");
      expect(body).not.toContain("[fonts]");
      expect(body).not.toContain("root:");
    }
  });
});

describe("resolveWithin", () => {
  const root = process.platform === "win32" ? "C:\\maya\\client" : "/maya/client";

  it("resolves a path inside the root", () => {
    expect(resolveWithin(root, "/app.js")).toBe(join(root, "app.js"));
    expect(resolveWithin(root, "/assets/style.css")).toBe(join(root, "assets", "style.css"));
  });

  it("refuses anything that climbs out, however it is spelled", () => {
    expect(resolveWithin(root, "/../secret")).toBeNull();
    expect(resolveWithin(root, "/a/../../secret")).toBeNull();
    expect(resolveWithin(root, "/%2e%2e/secret")).toBeNull();
    expect(resolveWithin(root, "/%00/secret")).toBeNull();
    // A sibling directory whose name merely starts with the root's name.
    expect(resolveWithin(root, "/../client-evil/x")).toBeNull();
  });

  it("refuses a malformed escape rather than guessing", () => {
    expect(resolveWithin(root, "/%zz")).toBeNull();
  });
});

describe("live signals", () => {
  it("tells connected views when the repository changes, without logging it", async () => {
    const { daemon, repoRoot, store } = await serve();
    const { WebSocket } = await import("ws");

    const socket = new WebSocket(`${daemon.address.replace("http", "ws")}/ws?since=0`);
    const signals: string[] = [];
    const events: number[] = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as
        | { kind: "signal"; signal: string }
        | { kind: "event"; event: { id: number } };
      if (message.kind === "signal") signals.push(message.signal);
      else events.push(message.event.id);
    });
    await new Promise((ready) => socket.once("open", ready));

    const before = store.latestId();
    writeFileSync(join(repoRoot, "new-file.ts"), "export {};\n", "utf8");

    for (let attempt = 0; attempt < 60 && signals.length === 0; attempt += 1) {
      await new Promise((wait) => setTimeout(wait, 100));
    }
    socket.close();

    expect(signals).toContain("files_changed");
    // A signal is not history: nothing was appended to the log for it, so a
    // long session of saves cannot bloat the event store.
    expect(store.latestId()).toBe(before);
    expect(events).toHaveLength(0);
  });
});
