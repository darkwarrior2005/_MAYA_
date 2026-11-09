// Phase A1 verification: the Operator splits one request into tasks, puts the
// split to the person in a real terminal, and runs what they chose.
//
//   pnpm build && node tools/verify/planning.mjs
//
// Needs the optional node-pty package. The agents are stand-ins configured as
// project plugins, so this costs nothing and is deterministic; what it
// exercises is the planning, the confirmation and the dispatch.
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const require_ = createRequire(join(repoRoot, "packages/core/package.json"));
const { spawn: ptySpawn } = require_("node-pty");
const MAYA = join(repoRoot, "packages/cli/dist/main.js");

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const NEWLINE = new RegExp(String.fromCharCode(13) + "?" + String.fromCharCode(10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) =>
  s
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "")
    .replace(new RegExp(`${ESC}[0-9A-Za-z=><]`, "g"), "");

const results = [];
const check = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
};

const PLUGIN = `
// Stand-ins: the operator plans and summarises, the worker writes a file.
export function createOperator() {
  return {
    id: "fake-operator", displayName: "Fake Operator",
    capabilities: { streaming: true, structuredOutput: false, resumable: false },
    async check() { return { installed: true, authenticated: true }; },
    async start(run) {
      const listeners = new Set();
      const planning = run.prompt.includes("Split this request into tasks");
      const summarising = run.prompt.includes("for a git commit message");
      return {
        agentId: run.agentId,
        onEvent(l) { listeners.add(l); return () => listeners.delete(l); },
        async waitForCompletion() {
          let text = "TASK: nothing to do";
          if (planning) {
            text = [
              "TASK: Create docs/parser.md describing the CSV parser",
              "TASK: Create docs/usage.md with usage examples",
              "NOTE: Separate files, so they merge cleanly.",
            ].join("\\n");
          } else if (summarising) {
            text = "SUBJECT: Document the CSV parser\\nBODY: Adds pages under docs/.";
          }
          for (const l of listeners) l({ type: "text", agentId: run.agentId, text });
          return { ok: true, stalled: false };
        },
        async interrupt() {}, async kill() {},
      };
    },
  };
}
export function createWorker() {
  return {
    id: "fake-worker", displayName: "Fake Worker",
    capabilities: { streaming: true, structuredOutput: false, resumable: false },
    async check() { return { installed: true, authenticated: true }; },
    async start(run) {
      const listeners = new Set();
      return {
        agentId: run.agentId,
        onEvent(l) { listeners.add(l); return () => listeners.delete(l); },
        async waitForCompletion() {
          const { writeFileSync, mkdirSync } = await import("node:fs");
          const { join, dirname } = await import("node:path");
          const match = /Create (\\S+)/.exec(run.prompt);
          const file = match ? match[1] : "notes-" + run.agentId + ".md";
          const target = join(run.cwd, file);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(target, "written by " + run.agentId + "\\n", "utf8");
          for (const l of listeners) l({ type: "text", agentId: run.agentId, text: "wrote " + file });
          return { ok: true, stalled: false };
        },
        async interrupt() {}, async kill() {},
      };
    },
  };
}
`;

async function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "maya-plan-"));
  await new Promise((done) =>
    spawn(process.execPath, [MAYA, "init", dir], { stdio: "ignore" }).on("close", done),
  );
  mkdirSync(join(dir, "plugins"), { recursive: true });
  writeFileSync(join(dir, "plugins", "stand-ins.mjs"), PLUGIN, "utf8");

  const configFile = join(dir, ".maya", "config.json");
  const config = JSON.parse(readFileSync(configFile, "utf8"));
  config.adapters = [
    { id: "fake-operator", module: "./plugins/stand-ins.mjs", export: "createOperator" },
    { id: "fake-worker", module: "./plugins/stand-ins.mjs", export: "createWorker" },
  ];
  config.operator = {
    id: "operator", tool: "fake-operator", displayName: "Operator",
    stallTimeoutSec: 30, enabled: true,
  };
  config.workers = [
    { id: "worker-a", tool: "fake-worker", displayName: "Worker A", stallTimeoutSec: 30, enabled: true },
    { id: "worker-b", tool: "fake-worker", displayName: "Worker B", stallTimeoutSec: 30, enabled: true },
  ];
  writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");
  return dir;
}

/** Runs `maya start --plan` in a real terminal and answers the question. */
async function planWith(answer, port) {
  const dir = await makeProject();
  let screen = "";
  const pty = ptySpawn(
    process.execPath,
    [MAYA, "start", "--plan", "document the CSV parser", "-d", dir, "-p", String(port)],
    { name: "xterm-256color", cols: 110, rows: 30, cwd: dir, env: { ...process.env } },
  );
  pty.onData((chunk) => (screen += chunk));

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && !strip(screen).includes("splits into")) await sleep(200);
  const asked = strip(screen);

  pty.write(answer + CR);
  const exited = new Promise((done) => pty.onExit(() => done()));
  await Promise.race([exited, sleep(30_000)]);
  return { dir, asked, screen: strip(screen) };
}

// --- accepting the split -----------------------------------------------------
const accepted = await planWith("1", 7971);
check("the Operator splits one request into tasks", accepted.asked.includes("splits into 2 tasks"));
check("it shows each task", accepted.asked.includes("Create docs/parser.md"));
check("it explains the split", accepted.asked.includes("merge cleanly"));
check("it offers to run it whole instead", accepted.asked.includes("one task instead"));
check(
  "both tasks ran and merged",
  existsSync(join(accepted.dir, "docs", "parser.md")) &&
    existsSync(join(accepted.dir, "docs", "usage.md")),
  accepted.screen.split("\n").filter((l) => l.startsWith("merged")).join(" | "),
);

const subjects = spawnSync("git", ["-C", accepted.dir, "log", "--format=%s", "-3"], {
  encoding: "utf8",
}).stdout;
check(
  "the commit message describes the change, not the request",
  subjects.includes("Document the CSV parser") && !subjects.includes("Create docs/parser.md"),
  subjects.trim().split(String.fromCharCode(10)).join(" | "),
);

// --- declining the split -----------------------------------------------------
const whole = await planWith("2", 7972);
check(
  "choosing one task runs the request whole",
  !existsSync(join(whole.dir, "docs", "parser.md")),
  "the planned files are not written",
);

// --- the person's own words --------------------------------------------------
const custom = await planWith("Create docs/custom.md only", 7973);
check(
  "their own words replace the plan",
  existsSync(join(custom.dir, "docs", "custom.md")) &&
    !existsSync(join(custom.dir, "docs", "parser.md")),
);

const failed = results.filter((pass) => !pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
