import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentDescriptor } from "@maya/shared-types";
import { MayaPaths } from "../src/config/maya-config.js";
import { ContextWriter } from "../src/persistence/context-writer.js";

const agent: AgentDescriptor = {
  id: "worker-1",
  role: "worker",
  tool: "copilot-cli",
  displayName: "Worker <One>",
  model: "gpt-5",
};

describe("ContextWriter", () => {
  it("writes timestamped and latest snapshots in both markdown and html", () => {
    const root = mkdtempSync(join(tmpdir(), "maya-ctx-"));
    const paths = new MayaPaths(root);
    paths.ensureDirs();

    const written = new ContextWriter(paths).write({
      agent,
      taskSummary: "do the thing",
      transcript: "line one\nline two",
      status: "completed",
    });

    expect(written).not.toBeNull();
    const dir = paths.agentDir("worker-1");
    expect(readFileSync(join(dir, "latest.md"), "utf8")).toContain("do the thing");
    expect(readFileSync(join(dir, "latest.html"), "utf8")).toContain("<h2>Transcript</h2>");
    expect(readFileSync(written!.md, "utf8")).toContain("line two");

    rmSync(root, { recursive: true, force: true });
  });

  it("escapes html so agent output cannot break the snapshot page", () => {
    const root = mkdtempSync(join(tmpdir(), "maya-ctx-"));
    const paths = new MayaPaths(root);
    paths.ensureDirs();

    new ContextWriter(paths).write({
      agent,
      taskSummary: "render <script>alert(1)</script>",
      transcript: "a & b",
      status: "completed",
    });

    const html = readFileSync(join(paths.agentDir("worker-1"), "latest.html"), "utf8");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("a &amp; b");
    expect(html).toContain("Worker &lt;One&gt;");

    rmSync(root, { recursive: true, force: true });
  });

  it("reports a warning instead of throwing when a snapshot cannot be written", () => {
    const paths = new MayaPaths(join(tmpdir(), "maya-missing-root"));
    const warnings: string[] = [];
    // Point the agent dir at a path that cannot be created as a directory.
    const writer = new ContextWriter(
      new Proxy(paths, {
        get(target, prop, receiver) {
          if (prop === "agentDir") return () => "\0invalid";
          return Reflect.get(target, prop, receiver);
        },
      }) as MayaPaths,
      (message) => warnings.push(message),
    );

    const result = writer.write({
      agent,
      taskSummary: "s",
      transcript: "t",
      status: "completed",
    });

    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("context snapshot");
  });
});
