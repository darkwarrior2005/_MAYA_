import type { AgentToolId, PlatformNote, ProbeResult } from "@maya/shared-types";

/**
 * What is known about each tool from driving it, as opposed to what a probe
 * measures on the day.
 *
 * Everything here was learned the hard way and is recorded in
 * `docs/FINDINGS.md`; this is the same knowledge in a form a person can read
 * before choosing which worker to enable.
 */
export const TAGLINES: Record<string, string> = {
  "claude-code": "Runs inside Maya. The most wired-in of the three.",
  "copilot-cli": "Capable, but every run costs a premium request.",
  "antigravity-cli": "The newest, and the least understood.",
};

const STATIC_PROS: Record<string, string[]> = {
  "claude-code": [
    "Runs in-process through the SDK, so there is no stream to mis-parse",
    "Reports tokens and cost per run, which is where the Info panel gets its figures",
    "Enforces its own turn and spend budgets when Maya asks it to",
    "Resumable: an interrupted run has a session to pick back up",
  ],
  "copilot-cli": [
    "Fine-grained permissions: a worker can be allowed edits and nothing else",
    "Auto-approves tools it judges read-only, so a status check needs no grant",
    "Streams structured JSON Maya can follow step by step",
  ],
  "antigravity-cli": [
    "Streams its thinking as it goes, so a pane fills while it works",
    "Accepts edits unattended without a blanket permission flag",
  ],
};

const STATIC_CONS: Record<string, string[]> = {
  "claude-code": [
    "Needs git-bash on Windows, and says so only on stderr",
    "A failed result can still be labelled success, so the error has to be read out of the body",
    "Its CLI auto-updates, which can drift away from the SDK Maya is pinned to",
  ],
  "copilot-cli": [
    "Costs one premium request per run, whatever the outcome",
    "Exits 0 after denying every tool call, so its own result cannot be trusted alone",
    "Permissions are patterns, not tool names: a wrong one silently grants nothing",
    "A VS Code install can put a shim on PATH that hides the real binary",
  ],
  "antigravity-cli": [
    "Its failure shape has never been observed, so success is inferred rather than read",
    "Sends text in fragments, which Maya has to reassemble per step",
    "Not on PATH as an executable Node can spawn directly — it resolves to a .cmd",
  ],
};

/** The pros, plus anything today's probes proved. */
export function knownPros(tool: AgentToolId, probes: ProbeResult[]): string[] {
  const pros = [...(STATIC_PROS[tool] ?? [])];
  const edit = probes.find((probe) => probe.id === "can-edit");
  if (edit?.outcome === "pass") pros.push(`Measured here: ${edit.detail}`);
  const restraint = probes.find((probe) => probe.id === "restraint");
  if (restraint?.outcome === "pass") pros.push("Measured here: left the tree alone when told to");
  return pros;
}

/** The cons, plus anything today's probes exposed. */
export function knownCons(tool: AgentToolId, probes: ProbeResult[]): string[] {
  const cons = [...(STATIC_CONS[tool] ?? [])];
  for (const probe of probes) {
    // A warning belongs here too — a shim is worth knowing about even though
    // it is not a failure — but a skipped probe measured nothing, and putting
    // "not measured" in a weaknesses list reads as a weakness.
    if (probe.outcome !== "fail" && probe.outcome !== "warn") continue;
    if (probe.id === "installed") cons.unshift("Not installed on this machine");
    else if (probe.id === "authenticated") {
      cons.unshift(
        probe.outcome === "warn"
          ? "Its login is assumed, not checked — a stored session can be expired"
          : "Installed, but not logged in",
      );
    }
    else if (probe.id === "binary") cons.unshift(`Resolved to a shim: ${probe.detail}`);
    else if (probe.id === "can-edit") cons.push(`Measured here: ${probe.detail}`);
    else if (probe.id === "restraint") cons.push(`Measured here: ${probe.detail}`);
  }
  return cons;
}

/**
 * Problems with Windows, with Maya, and with the way it keeps documentation —
 * the things that are nobody's agent's fault.
 */
export const PLATFORM_NOTES: PlatformNote[] = [
  {
    id: "conpty-size",
    area: "windows",
    title: "Windows never tells a program its window was resized",
    detail:
      "Under ConPTY, process.stdout.columns and .rows stay frozen at the size " +
      "the console had when the process started, and no resize event is ever " +
      "emitted. A frame drawn at the old size wraps and scrolls the screen.",
    mitigation:
      "Maya measures the terminal itself four times a second, by parking the " +
      "cursor at the bottom-right and asking where it landed.",
    severity: "handled",
  },
  {
    id: "conpty-width",
    area: "windows",
    title: "Emoji are wider than they look, and inconsistently so",
    detail:
      "ConPTY gives a flag 4 columns and a ZWJ family 8, where a clustering " +
      "terminal gives each 2. Under-counting wraps the line and breaks every " +
      "pane on the row.",
    mitigation:
      "Widths match ConPTY and deliberately over-estimate elsewhere: a gap at " +
      "the end of a line is harmless, a wrap is not.",
    severity: "handled",
  },
  {
    id: "legacy-console",
    area: "windows",
    title: "A legacy console turns anything but ASCII into mojibake",
    detail:
      "An unannounced Windows console often runs a non-UTF-8 code page, where " +
      "box-drawing borders and the em-dashes and curly quotes inside agent " +
      "output both come out as garbage.",
    mitigation:
      "On such a console Maya draws ASCII borders and folds the text between " +
      "them to ASCII too.",
    severity: "handled",
  },
  {
    id: "windows-locks",
    area: "windows",
    title: "Windows holds a file open after the process using it has gone",
    detail:
      "Deleting or renaming just after a child exits fails with EBUSY or " +
      "EPERM, which broke context snapshots and test cleanup.",
    mitigation:
      "Snapshots are written to a temp file and renamed with retries; a failed " +
      "snapshot is logged and skipped rather than crashing the daemon.",
    severity: "handled",
  },
  {
    id: "node-pty-linux",
    area: "maya",
    title: "The terminal probes need a native module Linux has no build for",
    detail:
      "node-pty ships prebuilt binaries for Windows and macOS only, so on " +
      "Linux it needs a C++ toolchain.",
    mitigation:
      "It is an optional dependency; nothing Maya does by default needs it, " +
      "and asking for the pty transport without it falls back to pipes.",
    severity: "handled",
  },
  {
    id: "linux-unverified",
    area: "maya",
    title: "Nothing has ever been run on Linux",
    detail:
      "Every command, test and harness in this project has run on Windows " +
      "only. The code avoids platform assumptions, but that is reasoning, not " +
      "evidence.",
    mitigation: "Run the suite and tools/verify/ on Linux before trusting it there.",
    severity: "open",
  },
  {
    id: "operator-cost",
    area: "maya",
    title: "A run costs real money and Maya cannot always stop it early",
    detail:
      "One measured Claude Code run on a one-line task cost $0.41. A denied " +
      "or looping agent keeps producing output, so a silence timer never fires.",
    mitigation:
      "Every run is bounded three ways — silence, wall clock and tokens — and " +
      "the ceilings are set per worker.",
    severity: "handled",
  },
  {
    id: "docs-snapshots",
    area: "docs",
    title: "Each agent's context is kept as paired Markdown and HTML",
    detail:
      "After every turn, Maya writes .maya/agents/<id>/latest.md and .html " +
      "plus a timestamped copy, so what an agent knew is readable afterwards " +
      "without a database tool. Lines an agent addressed to you are taken out " +
      "before the snapshot is written.",
    mitigation:
      "Written temp-then-rename with retries, and a failed write is logged " +
      "rather than lost silently.",
    severity: "handled",
  },
  {
    id: "docs-growth",
    area: "docs",
    title: "Snapshots and raw logs grow without a limit",
    detail:
      ".maya/agents/ keeps a timestamped snapshot per turn and .maya/logs/ " +
      "keeps every line each tool printed. Nothing prunes either.",
    mitigation:
      "They are inside .maya/, which is git-ignored, so they never reach a " +
      "commit — but a long-lived project will accumulate them.",
    severity: "open",
  },
  {
    id: "docs-plan",
    area: "docs",
    title: "The written record is the handover",
    detail:
      "docs/PLAN.md holds the target and phase status, docs/FINDINGS.md the " +
      "traps that each cost hours, docs/adr/ the decisions that went against " +
      "the plan, and bugfixy.md what is still open.",
    mitigation:
      "CLAUDE.md points at all of them and lists the invariants, so a new " +
      "agent reads the reasoning before touching the code.",
    severity: "handled",
  },
];
