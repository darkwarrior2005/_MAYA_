// Does Maya's own testing of its agents actually distinguish them?
//
//   pnpm build && node tools/verify/agents.mjs
//
// The agents here are stand-ins configured as project plugins, so this costs
// nothing and is deterministic. One does as it is told; the other ignores the
// instruction and edits anyway. If the scorecards come out the same, the
// probes are measuring nothing.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const MAYA = join(repoRoot, "packages/cli/dist/main.js");

const results = [];
const check = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
};

const PLUGIN = `
const base = (id, name) => ({
  id, displayName: name,
  capabilities: { streaming: true, structuredOutput: true, resumable: false },
  async check() { return { installed: true, authenticated: true, detail: "stand-in" }; },
});

/** Does what it is asked, and reports what it spent. */
export function createGoodAgent() {
  return {
    ...base("good-agent", "Good Agent"),
    async start(run) {
      const listeners = new Set();
      return {
        agentId: run.agentId,
        onEvent(l) { listeners.add(l); return () => listeners.delete(l); },
        async waitForCompletion() {
          const { writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const asked = /Create a file called (\\S+)/.exec(run.prompt);
          if (asked) writeFileSync(join(run.cwd, asked[1]), "hello from the probe\\n", "utf8");
          for (const l of listeners) {
            l({ type: "usage", agentId: run.agentId, usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.01 } });
          }
          return { ok: true, stalled: false };
        },
        async interrupt() {}, async kill() {},
      };
    },
  };
}

/** Does the task, then edits whatever else it likes, and never says what it spent. */
export function createRecklessAgent() {
  return {
    ...base("reckless-agent", "Reckless Agent"),
    async start(run) {
      const listeners = new Set();
      return {
        agentId: run.agentId,
        onEvent(l) { listeners.add(l); return () => listeners.delete(l); },
        async waitForCompletion() {
          const { writeFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const asked = /Create a file called (\\S+)/.exec(run.prompt);
          if (asked) writeFileSync(join(run.cwd, asked[1]), "fine\\n", "utf8");
          // ...and then writes something regardless of what it was told.
          writeFileSync(join(run.cwd, "UNASKED.txt"), "I did this anyway\\n", "utf8");
          return { ok: true, stalled: false };
        },
        async interrupt() {}, async kill() {},
      };
    },
  };
}

/**
 * Never gets going: its credentials are no good. This is the shape the first
 * real live run took, and it is the one that caught Maya flattering a tool —
 * a fast failure scored as speed, and an empty bill scored as cost reporting.
 */
export function createExpiredAgent() {
  return {
    ...base("expired-agent", "Expired Agent"),
    async start(run) {
      const listeners = new Set();
      return {
        agentId: run.agentId,
        onEvent(l) { listeners.add(l); return () => listeners.delete(l); },
        async waitForCompletion() {
          for (const l of listeners) {
            l({ type: "usage", agentId: run.agentId, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } });
          }
          return { ok: false, stalled: false, error: "Failed to authenticate: OAuth session expired" };
        },
        async interrupt() {}, async kill() {},
      };
    },
  };
}
`;

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAYA, ...args], { stdio: "pipe" });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const project = mkdtempSync(join(tmpdir(), "maya-agents-"));
await run(["init", project]);
mkdirSync(join(project, "plugins"), { recursive: true });
writeFileSync(join(project, "plugins", "stand-ins.mjs"), PLUGIN, "utf8");

const configFile = join(project, ".maya", "config.json");
const config = JSON.parse(readFileSync(configFile, "utf8"));
config.adapters = [
  { id: "good-agent", module: "./plugins/stand-ins.mjs", export: "createGoodAgent" },
  { id: "reckless-agent", module: "./plugins/stand-ins.mjs", export: "createRecklessAgent" },
  { id: "expired-agent", module: "./plugins/stand-ins.mjs", export: "createExpiredAgent" },
];
config.workers = [
  { id: "w-good", tool: "good-agent", displayName: "Good", stallTimeoutSec: 30, enabled: true },
];
writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");

// --- static only -------------------------------------------------------------
const stat = await run(["agents", "-d", project]);
check("`maya agents` runs without touching the agents", stat.code === 0);
check("it says the figures are static", stat.out.includes("Static checks only"));

// --- live --------------------------------------------------------------------
const live = await run(["agents", "-d", project, "--live"]);
check("`maya agents --live` completes", live.code === 0, live.out.trim().split("\n").at(-1));
check("it warns that this spends money", live.out.includes("spends money"));

const report = JSON.parse(readFileSync(join(project, ".maya", "agents-report.json"), "utf8"));
const good = report.agents.find((agent) => agent.tool === "good-agent");
const reckless = report.agents.find((agent) => agent.tool === "reckless-agent");
const expired = report.agents.find((agent) => agent.tool === "expired-agent");

check("every stand-in was scored", Boolean(good && reckless && expired));

const probeOf = (agent, id) => agent.probes.find((probe) => probe.id === id);

check(
  "it noticed which agent can edit a file",
  probeOf(good, "can-edit")?.outcome === "pass",
  probeOf(good, "can-edit")?.detail,
);
check(
  "it noticed which agent obeyed 'change nothing'",
  probeOf(good, "restraint")?.outcome === "pass",
);
check(
  "it caught the one that edited anyway",
  probeOf(reckless, "restraint")?.outcome === "fail",
  probeOf(reckless, "restraint")?.detail,
);
check(
  "it caught the one that never reported cost",
  probeOf(good, "reports-cost")?.outcome === "pass" &&
    probeOf(reckless, "reports-cost")?.outcome === "fail",
);

check(
  "the measured failures reach the weaknesses list",
  reckless.cons.some((con) => con.startsWith("Measured here:")),
  reckless.cons.find((con) => con.startsWith("Measured here:")),
);
check(
  "the measured passes reach the strengths list",
  good.pros.some((pro) => pro.startsWith("Measured here:")),
);
check(
  "the two agents do not score the same",
  good.stats.reliability !== reckless.stats.reliability,
  `good ${good.stats.reliability} vs reckless ${reckless.stats.reliability}`,
);
// --- a run that failed must not be flattered ---------------------------------
// Everything below came out of the first real live run, where an agent whose
// login had expired was scored the fastest of the three and credited with
// reporting what it spent.
check(
  "a failed run is not scored as a speed",
  probeOf(expired, "speed")?.outcome === "skipped",
  probeOf(expired, "speed")?.detail,
);
check(
  "the speed bar stays unmeasured after a failed run",
  expired.stats.speed === 50,
  `speed ${expired.stats.speed}`,
);
check(
  "a failed run does not beat a working one on speed",
  good.stats.speed >= expired.stats.speed,
  `good ${good.stats.speed} vs expired ${expired.stats.speed}`,
);
check(
  "an all-zero bill is not evidence that it reports cost",
  probeOf(expired, "reports-cost")?.outcome === "skipped",
  probeOf(expired, "reports-cost")?.detail,
);
check(
  "a run that never started is not credited with restraint",
  probeOf(expired, "restraint")?.outcome === "skipped",
  probeOf(expired, "restraint")?.detail,
);
check(
  "an expired login is not reported as a permissions problem",
  probeOf(expired, "can-edit")?.detail.includes("Log in again") === true &&
    probeOf(expired, "can-edit")?.detail.includes("grants edits only") === false,
  probeOf(expired, "can-edit")?.detail,
);

check("the report records that it was live", report.live === true);
check(
  "platform notes are included",
  report.platform.length > 0 &&
    report.platform.some((note) => note.area === "docs"),
  `${report.platform.length} notes`,
);

// --- served over HTTP --------------------------------------------------------
const web = spawn(process.execPath, [MAYA, "web", "-d", project, "--no-open", "--port", "7991"], {
  stdio: "pipe",
});
await new Promise((r) => setTimeout(r, 3000));
let served = null;
try {
  served = await (await fetch("http://127.0.0.1:7991/api/agents")).json();
} catch (error) {
  served = { error: String(error) };
}
web.kill();
check(
  "the daemon serves the scorecards",
  Array.isArray(served?.agents) && served.agents.length === report.agents.length,
  `${served?.agents?.length ?? 0} agents`,
);

const failed = results.filter((pass) => !pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
