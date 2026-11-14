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
  "claude-code": "Runs inside Maya. The most wired-in of them.",
  "copilot-cli": "Capable, but every run costs a premium request.",
  "antigravity-cli": "Thorough and slow, and the least understood of them.",
  "codex-cli": "Sandboxed by design. The only one that fences itself.",
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
  "codex-cli": [
    "Sandboxed rather than permissioned: writes are fenced to the workspace by the OS, not by the agent agreeing to behave",
    "Built for headless use — `codex exec` is a first-class mode, not a flag bolted onto a TUI",
    "Publishes its event stream, so Maya parses a documented schema instead of a reverse-engineered one",
    "Resumable by session id, and the id arrives in the first event of the run",
    "Reports cached input tokens separately, so a cheap repeat run shows as one",
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
    "A denied permission still reports the run as a success with an empty answer — Maya reads `denied_actions` to catch it",
    "Headless mode cannot prompt, so a command has to be granted in advance with `allowedTools: [\"command(npm test)\"]` on the worker",
    "Sends text in fragments, which Maya has to reassemble per step",
    "Slowest of the four on a one-line task, by a wide margin",
  ],
  "codex-cli": [
    "Defaults to a read-only sandbox, so a worker that is not given `workspace-write` cannot change anything",
    "Permission is one sandbox setting, not per-tool: you cannot allow edits while forbidding shell",
    "Refuses to run outside a git repository unless told to, which is fine for Maya and surprising elsewhere",
    "Installs as an npm shim, so the binary Maya runs is a .cmd and goes through cmd.exe — see the quoting note in subprocess-adapter.ts",
    "Reports tokens but not a cost, on a ChatGPT login — there is no per-run price to show",
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
    title: "Maya is driven on Windows and tested on Linux by CI",
    detail:
      "Day-to-day development happens on Windows. Linux is covered by CI on " +
      "every push — the suite, the MCP server, the agent probes, the packaged " +
      "bundle and the pane view all pass on ubuntu-latest — rather than by " +
      "anyone working there.",
    mitigation:
      "Both platforms run in .github/workflows/ci.yml, so a platform fault " +
      "surfaces on the next push instead of being argued about.",
    severity: "handled",
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

/**
 * Maya's own card, for the cast page.
 *
 * The pros are the claims this project is prepared to defend, and each one is
 * a thing the code actually does rather than a thing it aspires to — the
 * invariants in CLAUDE.md and the write-ups in docs/FINDINGS.md are where
 * each comes from.
 *
 * The cons are deliberately **not** written here. They are read from the
 * platform notes that are still `open`, so Maya's card cannot quietly stop
 * admitting something the rest of the codebase still records: closing a note
 * removes it from the card, and adding one puts it there, with no second list
 * to keep in step. If every note is handled the card says so rather than
 * pretending there is nothing to say.
 */
export const MAYA_PROS = [
  "The Operator alone merges, and never merges work that failed, stalled or came back empty",
  "Each worker edits its own git worktree, so one going wrong cannot touch your files",
  "No assistant is ever passed a skip-all-permissions flag; what each may do is written down per worker",
  "A tool reporting success is not taken at its word — a recorded error, a stall, or a run that changed nothing and told nobody all override it",
  "Both windows read one event log and replay from their last-seen event, so neither can go quietly stale",
  "Every figure on an agent's card was measured by running that agent; a measurement that could not be taken says so instead of showing a number",
  "A run is bounded three ways — silence, wall clock and tokens — so a looping assistant is stopped rather than left spending",
] as const;

/** Maya's tagline on the cast page. */
export const MAYA_TAGLINE = "Holds the git history, and has the only say over what lands.";

/**
 * What Maya is still bad at, taken from the platform notes rather than a
 * hand-written list. Only the open ones: a handled note is a trap that has
 * been dealt with, and listing it as a weakness would be false modesty.
 */
export function openPlatformWeaknesses(notes: PlatformNote[]): string[] {
  const open = notes.filter((note) => note.severity === "open");
  if (open.length === 0) {
    return ["Nothing recorded as open — every platform note is marked handled"];
  }
  return open.map((note) => `${note.title} — ${note.mitigation}`);
}
