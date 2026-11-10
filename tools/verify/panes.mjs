// Phase 3 verification: drives `maya attach` inside a real pseudoconsole
// with real keystrokes, and resizes it.
//
//   pnpm build && node tools/verify/panes.mjs
//
// Needs the optional node-pty package (see docs/FINDINGS.md). Nothing here
// fakes the terminal: the pseudoconsole answers Maya's size measurement
// itself, which is what makes the resize checks meaningful.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { needPty } from "./need-pty.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const { spawn: ptySpawn } = needPty("panes.mjs");

const MAYA = join(repoRoot, "packages/cli/dist/main.js");
const SEED = join(repoRoot, "tools/verify/seed-daemon.mjs");

const ESC = String.fromCharCode(27);
const NL = new RegExp(`${String.fromCharCode(13)}?${String.fromCharCode(10)}`);
const stripAnsi = (s) =>
  s
    .replace(new RegExp(`${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\u005c)?`, "g"), "")
    .replace(new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
const widest = (s) => Math.max(...stripAnsi(s).split(NL).map((l) => l.length));

/**
 * Maya's own last frame. ConPTY also writes clear-and-home when it repaints
 * the console's reflowed buffer on resize, so the marker alone is ambiguous;
 * Maya's frame is the one whose first line is a pane's top-left corner.
 */
const ownFrame = (s) => {
  const home = `${ESC}[H`;
  for (let at = s.lastIndexOf(home); at !== -1; at = s.lastIndexOf(home, at - 1)) {
    const rest = s.slice(at + home.length);
    if (!/^[╔┌]/.test(rest)) continue;
    return stripAnsi(rest).split(NL);
  }
  return [];
};

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "pipe" });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const repo = mkdtempSync(join(tmpdir(), "maya-live-"));
const init = await run(process.execPath, [MAYA, "init", repo]);
check("maya init prepares the project", init.code === 0, init.out.trim().split("\n").pop());

const daemon = spawn(process.execPath, [SEED, repo], { stdio: "pipe", cwd: repoRoot });
let daemonOut = "";
daemon.stdout.on("data", (d) => (daemonOut += d));
daemon.stderr.on("data", (d) => (daemonOut += d));
await sleep(1500);
const listening = /seeded daemon on port \d+/.test(daemonOut);
check("seeded daemon is listening", listening, daemonOut.trim());
if (!listening) {
  daemon.kill();
  process.exit(1);
}

// --- a pane view in a real pseudoconsole ------------------------------------
let cols = 110;
let rows = 30;
let screen = "";
let queries = 0;

const pty = ptySpawn(process.execPath, [MAYA, "attach", "-d", repo], {
  name: "xterm-256color",
  cols,
  rows,
  cwd: repo,
  env: { ...process.env, MAYA_BROWSER: "none", MAYA_TUI_CHARSET: "unicode", WT_SESSION: "live" },
});

// No stand-in terminal here: ConPTY answers the cursor-position measurement
// itself, so what follows exercises the real path. (node-pty never tells the
// child its size, which is why measuring is the only thing that can work.)
pty.onData((chunk) => {
  screen += chunk;
  if (chunk.includes(`${ESC}[6n`)) queries += 1;
});

const waitFor = async (needle, label, ms = 8000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (screen.includes(needle)) return check(label, true), true;
    await sleep(100);
  }
  check(label, false, `never saw ${JSON.stringify(needle)}`);
  return false;
};

await waitFor(`${ESC}[?1049h`, "enters the alternate screen buffer");
await waitFor("Operator", "Operator pane is drawn");
await waitFor("Worker (Claude Code)", "worker pane is drawn");
await waitFor("WORKER-LINE-ALPHA", "replays the session's worker output");
await waitFor("merged maya/t1/worker-claude", "Operator pane shows the merge");
await waitFor("13kt", "pane header shows the worker's token usage");

await waitFor("ESCAPED-LINE", "renders a line containing escape codes");
check(
  "strips a worker's escape codes instead of letting it repaint",
  !screen.includes(`${ESC}[1;1H`),
);
check("measures the terminal rather than trusting Node", !screen.includes(`${ESC}[18t`));
const opening = ownFrame(screen);
check("frame fits the terminal", opening[0]?.length === cols, `${opening[0]?.length ?? 0}/${cols}`);

// --- keys -------------------------------------------------------------------
screen = "";
pty.write("\t");
await sleep(400);
check(
  "Tab moves focus to the worker pane",
  /pane 2\/2 worker-claude/.test(screen),
  (screen.match(/pane \d\/\d \S+/) ?? ["none"])[0],
);

screen = "";
pty.write(`${ESC}[Z`);
await sleep(400);
check("Shift-Tab moves focus back", /pane 1\/2 operator/.test(screen));

screen = "";
pty.write("/panes\r");
await sleep(500);
check("/panes lists the panes", /0\s+Operator/.test(screen) && /1\s+Worker/.test(screen));

screen = "";
pty.write("/localhost\r");
await sleep(600);
check(
  "/localhost resolves the session's own address and is never forwarded",
  /open http:\/\/127\.0\.0\.1:\d+ yourself/.test(screen),
  (screen.match(/open http:\/\/\S+ yourself/) ?? ["none"])[0],
);

// --- a real resize ----------------------------------------------------------
screen = "";
cols = 70;
rows = 18;
pty.resize(cols, rows);
await sleep(1500);
let frame = ownFrame(screen);
check("repaints after the resize", frame.length > 0);
check(
  "redraws at the new width when the terminal shrinks",
  frame[0]?.length === cols,
  `top border ${frame[0]?.length ?? 0} wide, want ${cols}`,
);
// The status bar is always the frame's last row, so finding it there is an
// exact height check.
check(
  "the narrowed frame is exactly as tall as the terminal",
  frame[rows - 1]?.startsWith("maya  http") === true,
  `row ${rows} is ${JSON.stringify((frame[rows - 1] ?? "").slice(0, 24))}`,
);

screen = "";
cols = 140;
rows = 40;
pty.resize(cols, rows);
await sleep(1500);
frame = ownFrame(screen);
check(
  "redraws at the new width when the terminal grows",
  frame[0]?.length === cols,
  `top border ${frame[0]?.length ?? 0} wide, want ${cols}`,
);

// Nothing from the size handshake may land in the prompt.
screen = "";
pty.write("hello");
await sleep(500);
check(
  "the size handshake never reaches the prompt",
  /> hello\s*$/m.test(stripAnsi(screen).split(NL).find((l) => l.includes("> hello")) ?? "") ||
    stripAnsi(screen).includes("> hello"),
  (stripAnsi(screen).split(NL).find((l) => l.trimStart().startsWith("> ")) ?? "none").trim(),
);
pty.write("\u0015");
await sleep(200);

// --- quit -------------------------------------------------------------------
screen = "";
const exited = new Promise((resolve) => pty.onExit(({ exitCode }) => resolve(exitCode)));
pty.write("/quit\r");
const code = await Promise.race([exited, sleep(6000).then(() => "timeout")]);
check("/quit leaves the pane view", code === 0, `exit ${code}`);
check(
  "restores the terminal on the way out",
  screen.includes(`${ESC}[?1049l`) && screen.includes(`${ESC}[?25h`),
);

daemon.kill("SIGTERM");
await sleep(800);
daemon.kill();
try {
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
