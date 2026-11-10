// Phase 5 verification: does the same merge question render in a pane and in
// the web interface, and can either answer it?
//
//   pnpm build && node tools/verify/conflict.mjs
//
// Needs the optional node-pty package. The pane here answers it; the HTTP
// route the browser uses is covered by packages/core/test/http-api.test.ts.

import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { needPty } from "./need-pty.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const { spawn: ptySpawn } = needPty("conflict.mjs");
const require_ = createRequire(join(repoRoot, "packages/core/package.json"));
const { simpleGit } = require_("simple-git");
const core = await import(new URL("packages/core/dist/index.js", new URL("../../", import.meta.url)).href);
const { EventStore, EventBus, Daemon, MayaPaths, loadConfig, DeferredConflictResolver } = core;

const ESC = String.fromCharCode(27);
const NEWLINE = new RegExp(String.fromCharCode(13) + '?' + String.fromCharCode(10));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (s) =>
  s
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "")
    .replace(new RegExp(`${ESC}[0-9A-Za-z=><]`, "g"), "");

const root = mkdtempSync(join(tmpdir(), "maya-conflict-"));
const git = simpleGit(root);
await git.init();
await git.addConfig("user.email", "t@maya.local");
await git.addConfig("user.name", "T");
await git.raw(["checkout", "-B", "main"]);
await git.raw(["commit", "--allow-empty", "-m", "init"]);

const paths = new MayaPaths(root);
paths.ensureDirs();
const config = loadConfig(paths);
const store = new EventStore(paths.dbFile);
const bus = new EventBus(store);
const conflicts = new DeferredConflictResolver(bus);
const daemon = new Daemon({
  paths,
  bus,
  store,
  web: { repoRoot: root, git, store, bus, config, conflicts },
});
await daemon.start();

let screen = "";
const pty = ptySpawn(
  process.execPath,
  [join(repoRoot, "packages/cli/dist/main.js"), "attach", "-d", root],
  { name: "xterm-256color", cols: 120, rows: 30, cwd: root, env: { ...process.env, MAYA_BROWSER: "none" } },
);
pty.onData((c) => (screen += c));
await sleep(2500);

const results = [];
const check = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
};

// --- the question appears ---------------------------------------------------
screen = "";
const asked = conflicts.resolve({
  question: "src/parser.ts conflicts with main. How should this be handled?",
  options: [
    { id: "hold", label: "Keep the work on its branch" },
    { id: "discard", label: "Abandon this branch", proposedBy: "worker-copilot" },
  ],
});
await sleep(1500);
check("the pane shows the question", text(screen).includes("How should this be handled?"));
check("the pane lists the options", text(screen).includes("Abandon this branch"));
check("the pane names who proposed one", text(screen).includes("(worker-copilot)"));
check("the prompt asks for an answer", text(screen).includes("answer>"));

// --- answered somewhere else ------------------------------------------------
screen = "";
pty.write("2" + String.fromCharCode(13));
const answer = await asked;
check("typing 2 in the pane answers the Operator", answer.chosen === "discard", JSON.stringify(answer));

await sleep(2000);
const after = text(screen);
check("the pane redrew after the answer", after.trim().length > 0, `${after.trim().length} chars`);
const frame = after.split(NEWLINE).filter((l) => l.trim());
console.log("--- last frame lines ---");
for (const l of frame.slice(-8)) console.log("   " + JSON.stringify(l.slice(0, 116)));
check("the pane records the decision", after.includes("decided: discard"));

pty.write("/quit\r");
await sleep(600);
await daemon.stop();
store.close();
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exit(results.every(Boolean) ? 0 : 1);
