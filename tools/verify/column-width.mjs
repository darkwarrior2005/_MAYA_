// Ground truth for column widths: prints text into a real pseudoconsole and
// asks the terminal where the cursor landed. That is exactly how many columns
// it advanced, and it is the only way to settle a width question.
//
//   pnpm build && node tools/verify/column-width.mjs
//
// A mismatch means packages/cli/src/tui/width.ts disagrees with the terminal
// it is drawing on, which is how a pane frame ends up wrapping.
//
// Needs the optional node-pty package.
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const require_ = createRequire(join(repoRoot, "packages/core/package.json"));
const { spawn: ptySpawn } = require_("node-pty");
const { displayWidth } = await import(
  new URL("packages/cli/dist/tui/width.js", new URL("../../", import.meta.url)).href
);

const SAMPLES = [
  ["ascii", "hello"],
  ["check mark U+2713", "✓"],
  ["white heavy check U+2705", "✅"],
  ["rocket U+1F680", "🚀"],
  ["sparkles U+2728", "✨"],
  ["warning U+26A0", "⚠"],
  ["warning + VS16", "⚠️"],
  ["cross mark U+274C", "❌"],
  ["arrow U+2192", "→"],
  ["bullet U+2022", "•"],
  ["CJK pair", "文字"],
  ["flag JP", "🇯🇵"],
  ["ZWJ family", "👩‍👩‍👧"],
  ["combining accent", "café"],
];

// The child reports each measurement as it takes it. Batching them into one
// write at the end loses the last entry when the pty splits the write.
const child = `
const ESC = String.fromCharCode(27);
const samples = ${JSON.stringify(SAMPLES)};
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

let pending = null;
process.stdin.on("data", (data) => {
  const match = /\\u001b\\[(\\d+);(\\d+)R/.exec(data);
  if (match && pending) {
    const settle = pending;
    pending = null;
    settle(Number(match[2]));
  }
});

const columnAfter = (text) =>
  new Promise((done) => {
    pending = done;
    process.stdout.write(ESC + "[H" + ESC + "[2K" + text + ESC + "[6n");
  });

(async () => {
  for (const [label, text] of samples) {
    const column = await columnAfter(text);
    process.stderr.write("MEASURED " + label + " = " + (column - 1) + "\\n");
    await new Promise((r) => setTimeout(r, 60));
  }
  process.stderr.write("DONE\\n");
  process.exit(0);
})();
`;

let out = "";
const pty = ptySpawn(process.execPath, ["-e", child], {
  name: "xterm-256color",
  cols: 200,
  rows: 10,
  cwd: repoRoot,
  env: process.env,
});
pty.onData((chunk) => (out += chunk));

const deadline = Date.now() + 20_000;
while (Date.now() < deadline && !out.includes("DONE")) {
  await new Promise((r) => setTimeout(r, 200));
}

const measured = new Map();
for (const line of out.split(/\r?\n/)) {
  const match = /MEASURED (.+) = (\d+)/.exec(line);
  if (match) measured.set(match[1], Number(match[2]));
}

console.log("sample".padEnd(26), "terminal", "maya");
let wrong = 0;
for (const [label, text] of SAMPLES) {
  const actual = measured.get(label);
  const mine = displayWidth(text);
  if (actual === undefined) {
    console.log(label.padEnd(26), "no report from the terminal");
    wrong += 1;
    continue;
  }
  const ok = actual === mine;
  if (!ok) wrong += 1;
  console.log(label.padEnd(26), String(actual).padEnd(9), String(mine), ok ? "" : "<-- MISMATCH");
}

console.log(`\n${SAMPLES.length - wrong}/${SAMPLES.length} agree with the terminal`);
process.exit(wrong === 0 ? 0 : 1);
