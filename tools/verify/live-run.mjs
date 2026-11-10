// Phase 3 end to end: a real Claude Code run rendered in the pane view,
// inside a real pseudoconsole.
//
//   pnpm build && node tools/verify/live-run.mjs
//
// This spends a real agent run (roughly $0.40 on Opus) and needs the wrapped
// CLI to be logged in. Needs the optional node-pty package.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { needPty } from "./need-pty.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const { spawn: ptySpawn } = needPty("live-run.mjs");
const MAYA = join(repoRoot, "packages/cli/dist/main.js");
const ESC = String.fromCharCode(27);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
};

const repo = mkdtempSync(join(tmpdir(), "maya-live-run-"));
await new Promise((r) =>
  spawn(process.execPath, [MAYA, "init", repo], { stdio: "ignore" }).on("close", r),
);

let screen = "";
const pty = ptySpawn(
  process.execPath,
  [
    MAYA,
    "start",
    "--tui",
    "-d",
    repo,
    "Create a file called NOTES.md containing exactly one line: Maya orchestrates coding agents.",
  ],
  {
    name: "xterm-256color",
    cols: 120,
    rows: 34,
    cwd: repo,
    env: { ...process.env, MAYA_BROWSER: "none", WT_SESSION: "live" },
  },
);
pty.onData((c) => (screen += c));

const waitFor = async (needle, label, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (screen.includes(needle)) {
      check(label, true);
      return true;
    }
    await sleep(250);
  }
  check(label, false, `never saw ${JSON.stringify(needle)}`);
  return false;
};

await waitFor("Operator", "panes open before the agent starts", 15000);
await waitFor("worker-claude", "the task is assigned to the worker in the Operator pane", 20000);
await waitFor("Worker (Claude Code)", "the worker has its own pane", 20000);
await waitFor("- Write", "the worker's tool calls stream into its pane", 180000);
await waitFor("run finished", "the run completes with the panes still up", 180000);

const merged = screen.includes("merged maya/");
check("the Operator merged the branch", merged, merged ? "" : "no merge line in the Operator pane");
const usage = /\d+(\.\d+)?kt/.test(screen);
check("token usage reached the pane header", usage);

screen = "";
const exited = new Promise((resolve) => pty.onExit(({ exitCode }) => resolve(exitCode)));
pty.write("/quit\r");
const code = await Promise.race([exited, sleep(15000).then(() => "timeout")]);
check("/quit ends the session", code === 0 || code === 1, `exit ${code}`);
check("terminal restored", screen.includes(`${ESC}[?1049l`));

const notes = join(repo, "NOTES.md");
check("the agent's file landed on main", existsSync(notes), existsSync(notes) ? readFileSync(notes, "utf8").trim() : "missing");

const log = join(repo, ".maya", "agents", "worker-claude", "latest.md");
check("a context snapshot was written", existsSync(log));

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`repo: ${repo}`);
process.exit(failed.length === 0 ? 0 : 1);
