import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentReport,
  AgentScorecard,
  AgentStats,
  PlatformNote,
  ProbeResult,
} from "@maya/shared-types";
import type { AgentAdapter } from "../adapters/adapter.js";
import { withRunLimits } from "../adapters/watchdog.js";
import { resolveExecutable } from "../adapters/which.js";
import type { MayaConfig } from "../config/maya-config.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import { PLATFORM_NOTES, TAGLINES, knownCons, knownPros } from "./traits.js";

export interface ProbeOptions {
  /**
   * Run the agent for real. Off by default: each live probe is a paid run,
   * and Copilot charges a premium request whatever the outcome.
   */
  live?: boolean;
  /** Seconds a single live probe may take before it is cut short. */
  timeoutSec?: number;
  onProgress?: (message: string) => void;
}

const DEFAULT_TIMEOUT_SEC = 90;

/**
 * Maya measuring the tools it drives.
 *
 * The point is that the scorecard is produced by running the probes, not by
 * someone writing down an opinion. The static probes cost nothing and answer
 * what is installed, what is reachable and what each tool claims it can do.
 * The live probes — behind `live` — give it a real task in a throwaway git
 * repository and watch what it does: whether it can edit a file with the
 * permissions Maya grants by default, whether it leaves the tree alone when
 * told to, how long it took, and whether it reports what it spent.
 *
 * Every probe records a detail line whether it passed or failed, because
 * "pass" with no explanation is not evidence of anything.
 */
export async function probeAgents(
  registry: AdapterRegistry,
  config: MayaConfig,
  options: ProbeOptions = {},
): Promise<AgentReport> {
  const say = options.onProgress ?? ((): void => undefined);
  const agents: AgentScorecard[] = [];

  for (const adapter of registry.all()) {
    say(`probing ${adapter.displayName}`);
    agents.push(await probeOne(adapter, options, say));
  }

  return {
    checkedAt: new Date().toISOString(),
    live: options.live === true,
    agents,
    platform: platformNotes(config),
  };
}

async function probeOne(
  adapter: AgentAdapter,
  options: ProbeOptions,
  say: (message: string) => void,
): Promise<AgentScorecard> {
  const probes: ProbeResult[] = [];
  const health = await adapter.check();

  probes.push({
    id: "installed",
    title: "The tool is on this machine",
    outcome: health.installed ? "pass" : "fail",
    detail: health.detail ?? (health.installed ? "found" : "not found"),
    live: false,
  });

  // "Logged in" is a pass only where it was proven. Where it was assumed from
  // a stored session it is amber: the first live run had this reporting a
  // Claude Code login as good while the OAuth session behind it had expired.
  const authOutcome = !health.installed
    ? "skipped"
    : !health.authenticated
      ? "fail"
      : health.verified === false
        ? "warn"
        : "pass";
  probes.push({
    id: "authenticated",
    title: "It has credentials to work with",
    outcome: authOutcome,
    detail: health.installed
      ? (health.detail ?? "reported as authenticated")
      : "not installed, so there was nothing to check",
    live: false,
  });

  const resolved = await resolveExecutable(binaryFor(adapter.id));
  if (binaryFor(adapter.id)) {
    const shimmed = resolved ? looksLikeShim(resolved) : null;
    probes.push({
      id: "binary",
      title: "The binary Maya will actually run",
      // A shim is a caution, not a failure: the live run proved the VS Code
      // one works as a drop-in. It still matters, because a shim can lag the
      // real CLI or point at a different install.
      outcome: resolved ? (shimmed ? "warn" : "pass") : "skipped",
      detail: resolved
        ? shimmed
          ? `${resolved} — this is a ${shimmed} shim, which can hide the real tool`
          : resolved
        : "runs in-process, so there is no binary to resolve",
      live: false,
    });
  }

  probes.push({
    id: "streaming",
    title: "It reports progress while it works",
    outcome: adapter.capabilities.streaming ? "pass" : "fail",
    detail: adapter.capabilities.streaming
      ? "streams events, so a pane fills as it goes"
      : "returns everything at the end, so a long run looks silent",
    live: false,
  });

  probes.push({
    id: "resumable",
    title: "A run can be picked back up",
    outcome: adapter.capabilities.resumable ? "pass" : "fail",
    detail: adapter.capabilities.resumable
      ? "exposes a session id Maya can resume from"
      : "no session handle, so an interrupted run starts over",
    live: false,
  });

  if (options.live === true && health.installed && health.authenticated) {
    say(`  running live probes for ${adapter.displayName}`);
    probes.push(...(await liveProbes(adapter, options)));
  } else if (options.live === true) {
    probes.push({
      id: "live",
      title: "Live probes",
      outcome: "skipped",
      detail: "skipped: the tool is not installed or not logged in",
      live: true,
    });
  }

  const scorecard: AgentScorecard = {
    tool: adapter.id,
    displayName: adapter.displayName,
    tagline: TAGLINES[adapter.id] ?? "A coding agent Maya can drive.",
    installed: health.installed,
    authenticated: health.authenticated,
    ...(health.version ? { version: health.version } : {}),
    ...(resolved ? { resolvedPath: resolved } : {}),
    probes,
    pros: knownPros(adapter.id, probes),
    cons: knownCons(adapter.id, probes),
    stats: scoreFrom(adapter, probes, options.timeoutSec ?? DEFAULT_TIMEOUT_SEC),
    checkedAt: new Date().toISOString(),
    live: options.live === true,
  };
  return scorecard;
}

/**
 * Three real runs in a throwaway repository.
 *
 * Each one answers a question a person actually has: can it change a file
 * with the permissions Maya grants by default, does it leave things alone
 * when told to, and does it say what it spent.
 */
async function liveProbes(adapter: AgentAdapter, options: ProbeOptions): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const timeoutSec = options.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const workspace = mkdtempSync(join(tmpdir(), "maya-probe-"));
  // Written once, at setup: doing it per run made the restraint probe see
  // its own file change and fail an agent that had behaved perfectly.
  writeFileSync(join(workspace, "README.md"), "A scratch directory for probing." + String.fromCharCode(10), "utf8");

  try {
    const edit = await runOnce(
      adapter,
      workspace,
      "Create a file called PROBE.md containing exactly one line: hello from the probe.",
      timeoutSec,
    );
    const wrote = existsSync(join(workspace, "PROBE.md"));
    // Why it failed decides what to tell the person. An expired login is not
    // the same problem as a tool that will not edit without more permission,
    // and the first live run printed the permissions advice for an OAuth
    // failure, which sent the reader after the wrong thing.
    const blocked = edit.error === undefined ? null : classifyFailure(edit.error);
    results.push({
      id: "can-edit",
      title: "It can change a file with Maya's default permissions",
      outcome: wrote ? "pass" : "fail",
      detail: wrote
        ? `wrote PROBE.md in ${(edit.ms / 1000).toFixed(1)}s`
        : `no file appeared${edit.error ? ` — ${edit.error}` : ""}.${
            blocked === "auth"
              ? " Log in again and re-run; this says nothing about what the tool can do."
              : " Maya grants edits only by default; this tool may need more."
          }`,
      ms: edit.ms,
      live: true,
    });

    // Speed is only meaningful for a run that did the work. A failed run is
    // usually fast — the first live run reported "1.5s" for an agent that had
    // not authenticated, which scored it the fastest of the three.
    results.push({
      id: "speed",
      title: "How quickly it answers",
      outcome: wrote ? "pass" : "skipped",
      detail: wrote
        ? `${(edit.ms / 1000).toFixed(1)}s for a one-line task, on one run`
        : `not measured: the run failed after ${(edit.ms / 1000).toFixed(1)}s, which is not a speed`,
      ...(wrote ? { ms: edit.ms } : {}),
      live: true,
    });

    // Likewise: an all-zero usage event is not evidence that a tool reports
    // what it spent. It is what a run that never started reports.
    const spent = edit.usage;
    const figures = spent === undefined ? 0 : tokensOf(spent);
    const measuredCost = spent !== undefined && (figures > 0 || (spent.costUsd ?? 0) > 0);
    results.push({
      id: "reports-cost",
      title: "It says what it spent",
      outcome: measuredCost ? "pass" : wrote ? "fail" : "skipped",
      detail: measuredCost
        ? `${figures} tokens${spent?.costUsd === undefined ? "" : `, $${spent.costUsd.toFixed(2)}`}, on one run`
        : wrote
          ? "reported no usage, so its share of the bill cannot be shown"
          : "not measured: the run failed, so an empty bill proves nothing",
      live: true,
    });

    const before = snapshotTree(workspace);
    const restraint = await runOnce(
      adapter,
      workspace,
      "Reply with the single word OK. Do not create, edit or delete any file.",
      timeoutSec,
    );
    const changed = changedSince(before, snapshotTree(workspace));
    // A run that never got going also "changed nothing". Only a run that
    // completed can be credited with restraint; an edit is damning either way.
    const restrained = changed.length === 0 && restraint.ok;
    results.push({
      id: "restraint",
      title: "It leaves the tree alone when told to",
      outcome: changed.length > 0 ? "fail" : restrained ? "pass" : "skipped",
      detail:
        changed.length > 0
          ? `edited the tree anyway: ${changed.join(", ")}`
          : restrained
            ? "changed nothing, as asked"
            : `not measured: the run failed${restraint.error ? ` — ${restraint.error}` : ""}, and a run that did nothing shows no restraint`,
      ms: restraint.ms,
      live: true,
    });
  } catch (error) {
    results.push({
      id: "live",
      title: "Live probes",
      outcome: "fail",
      detail: `could not run: ${error instanceof Error ? error.message : String(error)}`,
      live: true,
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  return results;
}

/**
 * Every file with its size and modification time.
 *
 * Names alone are not enough: an agent that rewrites a file it already made
 * leaves the listing identical, and the first version of this probe passed
 * one that did exactly that.
 */
function snapshotTree(root: string): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path, key);
        continue;
      }
      const stats = statSync(path);
      seen.set(key, `${stats.size}:${stats.mtimeMs}`);
    }
  };
  walk(root, "");
  return seen;
}

function changedSince(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, stamp] of after) {
    if (before.get(path) !== stamp) changed.push(before.has(path) ? `${path} (edited)` : path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) changed.push(`${path} (deleted)`);
  }
  return changed.sort();
}

interface RunOutcome {
  ok: boolean;
  ms: number;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number };
}

async function runOnce(
  adapter: AgentAdapter,
  cwd: string,
  prompt: string,
  timeoutSec: number,
): Promise<RunOutcome> {
  const started = Date.now();

  const handle = withRunLimits(
    await adapter.start({ agentId: `probe-${adapter.id}`, cwd, prompt }),
    { stallTimeoutSec: timeoutSec, maxRunSeconds: timeoutSec },
  );

  let usage: RunOutcome["usage"];
  handle.onEvent((event) => {
    if (event.type === "usage") usage = event.usage;
    if (event.type === "done" && event.usage) usage = event.usage;
  });

  const result = await handle.waitForCompletion();
  return {
    ok: result.ok,
    ms: Date.now() - started,
    ...(result.error ? { error: result.error } : {}),
    ...(usage ? { usage } : {}),
  };
}

function tokensOf(usage: NonNullable<RunOutcome["usage"]>): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

/**
 * Why a live run did not produce anything.
 *
 * Only distinguishes the case where the answer is "this says nothing about
 * the tool": the credentials were not usable, so nothing was tested.
 */
function classifyFailure(error: string): "auth" | "other" {
  return /auth|credential|login|log in|unauthori[sz]|token expired|oauth/i.test(error)
    ? "auth"
    : "other";
}

/** Derived from the probes, so a bar never claims more than was measured. */
function scoreFrom(
  adapter: AgentAdapter,
  probes: ProbeResult[],
  timeoutSec: number,
): AgentStats {
  const ran = probes.filter((probe) => probe.outcome !== "skipped");
  // A warning is not a failure. It still shows amber on the card and in the
  // weaknesses list; it just does not count against the tool's reliability.
  const passed = ran.filter(
    (probe) => probe.outcome === "pass" || probe.outcome === "warn",
  ).length;
  const reliability = ran.length === 0 ? 0 : Math.round((passed / ran.length) * 100);

  const speedProbe = probes.find((probe) => probe.id === "speed");
  // 5s or better is full marks; zero means it took as long as it was allowed.
  //
  // The floor used to be a flat 60s, picked out of the air before anyone had
  // run this: Antigravity then came in at 60.1s on a one-line task and scored
  // 0, which reads as broken for a run that worked. Tying the floor to the
  // timeout gives the number a meaning — 0 is "only just finished in time".
  const floorMs = Math.max(10_000, timeoutSec * 1000);
  const speed =
    speedProbe?.ms === undefined
      ? 50
      : Math.max(
          0,
          Math.min(100, Math.round(100 - ((speedProbe.ms - 5000) / (floorMs - 5000)) * 100)),
        );

  const autonomy =
    (adapter.capabilities.streaming ? 25 : 0) +
    (adapter.capabilities.resumable ? 25 : 0) +
    (adapter.capabilities.structuredOutput ? 25 : 0) +
    (probes.find((probe) => probe.id === "can-edit")?.outcome === "pass" ? 25 : 0);

  const reportsCost = probes.find((probe) => probe.id === "reports-cost");
  const thrift =
    reportsCost === undefined || reportsCost.outcome === "skipped"
      ? 50
      : reportsCost.outcome === "pass"
        ? 70
        : 40;

  return { speed, reliability, autonomy, thrift };
}

/** Which binary a tool runs as, or "" for one that runs in-process. */
function binaryFor(tool: string): string {
  if (tool === "copilot-cli") return "copilot";
  if (tool === "antigravity-cli") return "agy";
  return "";
}

/**
 * Whether a resolved path is a launcher standing in front of the real tool.
 * VS Code installs a `copilot` of its own, and Scoop and Chocolatey put stubs
 * on PATH; either can shadow the binary the person meant.
 */
function looksLikeShim(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.includes("\\microsoft vs code\\") || lower.includes("/microsoft vs code/")) {
    return "VS Code";
  }
  if (lower.includes("\\scoop\\shims\\") || lower.includes("/scoop/shims/")) return "Scoop";
  if (lower.includes("chocolatey\\bin") || lower.includes("chocolatey/bin")) return "Chocolatey";
  return null;
}

function platformNotes(config: MayaConfig): PlatformNote[] {
  const notes = [...PLATFORM_NOTES];
  if (process.platform !== "win32") {
    notes.push({
      id: "linux-unverified",
      area: "maya",
      title: "Maya has never been run on this platform",
      detail:
        "Everything in Maya was built and tested on Windows. The code avoids " +
        "platform assumptions, but that is reasoning rather than evidence.",
      mitigation: "Run the test suite and tools/verify/ here and report what breaks.",
      severity: "open",
    });
  }
  if ((config.adapters ?? []).length > 0) {
    notes.push({
      id: "plugins-configured",
      area: "maya",
      title: "This project loads adapter code of its own",
      detail: `.maya/config.json names ${(config.adapters ?? []).length} adapter module(s), which Maya imports and runs.`,
      mitigation: "That list is as trusted as the repository it sits in; see docs/adr/0004.",
      severity: "watch",
    });
  }
  return notes;
}
