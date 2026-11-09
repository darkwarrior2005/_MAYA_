# bugfixy — what is wrong with Maya now, and how to fix it

A second plan, written after building all six phases of `docs/PLAN.md` and
reviewing the result end to end.

Every issue below was **verified against running code**, not inferred. Where a
number appears, it was measured. Three bugs found in the review are already
fixed (`ca26809`, `4383efb`) and are not repeated here.

Status: 170 tests, lint clean, six verification harnesses passing, on Windows.

**Update.** B1, B2, D1–D3 and A3 are now fixed, and an MCP server plus two
agent skills have been added. What is left is marked **OPEN** below; the
fixed entries are kept for the reasoning, with what was done.

---

## The short version

Maya does what the plan said and most of what the brief said. The gap that
matters is that **the Operator is not an agent**. It schedules, merges, and
has final say, but it never thinks: it never decomposes a request, never
summarises what a worker did, and never reviews work before merging it. Every
other open issue is smaller than that one.

Priorities: **A1–A3** make Maya match its own brief. **B1–B2** are correctness
and cost. **C1** is the one that decides whether "cross-platform" is a claim or
a guess.

---

## A. The Operator does not think

### A1 — The Operator still cannot split a request — **OPEN**

**Evidence.** Grepping every use of `config.operator` finds it in `doctor.ts`
(health check), `init.ts` (printing), `run.ts` (a fallback worker profile),
the pane title, and the `/api/session` payload. No code path starts an agent
with it. `Operator.run(instructions: string[])` takes the task list already
split, from `argv`.

**Impact.** The brief describes an Operator that "delegates tasks, writes
summaries, maintains the git repository and has final say". It has final say
and it maintains the repository. It delegates only in the sense of a
round-robin over a list the user typed. A one-line request cannot become three
tasks, because nothing can split it.

**Fix.** Add `orchestrator/planner.ts`: run the operator profile through its
adapter with a prompt that turns one request into a task list, and parse the
result. Three things make this safe rather than magic:

- Return a typed `TaskSpec[]`; refuse output that does not parse, and fall
  back to "one task, the request verbatim" — today's behaviour — so a planning
  failure degrades instead of blocking.
- Put the proposed split on the bus as a `conflict_prompt`-shaped question
  before dispatching, so the user sees the plan and can change it. The
  machinery for that already exists and renders in both interfaces.
- Keep `maya start "a" "b" "c"` working as the explicit form. Planning is what
  happens when given *one* instruction and `--plan`.

**Effort.** Moderate. The adapter, bus, prompt flow and both UIs already exist;
this is a new module plus a flag.

### A2 — A worker has no way to ask the Operator anything — **OPEN**

**Evidence.** The only agent-initiated channel is the `@user` marker, which
goes to the user. There is no worker→Operator path in `core/src/orchestrator`.

**Impact.** The brief says "sub-agents ask the Operator for information". A
worker that needs to know something can only interrupt the human, which is
exactly what the Operator exists to avoid.

**Fix.** Mirror the secret channel, which already works end to end. Add an
`@operator` marker handled in `secret-channel.ts` alongside `@user`; route it
to a new `question` payload on the `main` channel; have the Operator answer it
by running its adapter with the worker's question plus the task context, and
publish the answer back. Until A1 lands, a stub Operator can answer "ask the
user" and the plumbing is still correct.

**Effort.** Small once A1 exists, because the answering step needs an agent.
The marker, routing and payload are a day's work on their own.

### A3 — Summaries were the task text truncated — **FIXED**

**Evidence.** `firstLine(instruction)` in both `operator.ts` and
`task-runner.ts` produces every `summary` — in the task queue, in
`task_assigned` and `task_completed` events, and in the commit message.
`summary-generator.ts`, named in the original plan's module list, was never
built.

**Impact.** The To-Do panel, the chat and the git history all describe what was
*asked*, never what was *done*. A merge commit says "add a parser" whether the
agent wrote a parser or edited a README.

**Fix.** Build `orchestrator/summary-generator.ts`: after a worker finishes,
run the operator profile over the worker's transcript and diff
(`git diff --stat` against the base) and produce a one-line subject plus a
short body. Use it for the commit message and the `task_completed` event.
Fall back to today's `firstLine` when the operator adapter is unavailable, so
this never blocks a run.

**Effort.** Small, and it depends on nothing except having an operator adapter
to call.

---

## B. Correctness and cost

### B1 — Secret-channel text in the snapshot — **FIXED**

**Evidence.** A plugin adapter emitting
`@user the admin password for staging is hunter2 - is that right?` produced
that exact line at `.maya/agents/worker-s/latest.md:18`. `TaskRunner` and
`Operator` push `event.text` into `transcript` *before* `publishAgentEvent`
splits the channels, so the snapshot gets the unsplit text.

**Impact.** Content the user was told goes "directly to you, not through the
Operator" is sitting in a file beside the ordinary transcript. It is not
committed — `.maya/` is git-excluded, and the history confirms it — so this is
local only. But it contradicts what the channel promises, and any future
Operator that summarises from snapshots (A3) would read it.

**Fix.** Split before recording, not after. Move the split into a small helper
that returns both the events to publish and the text to record, and have the
transcript take only the main part. One line in each of the two call sites,
plus a test asserting the marker never reaches `latest.md`.

**Effort.** Small. Do this one first; it is the cheapest real fix here.

### B2 — Nothing bounds what a run can spend — **FIXED**

**Evidence.** `ClaudeCodeAdapterOptions` accepts `maxTurns` and
`maxBudgetUsd`; nothing sets them. Copilot and Antigravity have no equivalent
option. A single measured Claude Code run on a one-line task cost **$0.41**
(4 input, 220 output, 43k cache-read, 49k cache-write tokens).

**Impact.** A denied or looping agent keeps producing output, so the stall
watchdog never fires — it only watches for silence. Budget enforcement was
deliberately deferred for v1, which was the right call then and is not any
more now that the rest works.

**Fix.** Three layers, in increasing cost:

1. Wire `maxTurns` and `maxBudgetUsd` from `WorkerProfile` into the Claude
   adapter. Nearly free; the options exist.
2. Add a per-run ceiling in `watchdog.ts` alongside the silence timer: a wall
   clock limit and a token ceiling computed from `usage` events, killing the
   run and reporting it like a stall. This covers every adapter, including
   plugins, because it works off normalized events.
3. Surface the running total per task in the Info panel, which already has the
   data.

**Effort.** 1 is trivial, 2 is small and worth doing because it is adapter
agnostic.

### B3 — Antigravity's failure shape is guessed — **OPEN**

**Evidence.** The comment in `antigravity-cli.ts` says so: success is inferred
from reaching `state: "DONE"` without an error field, because no failing
sample was ever captured.

**Impact.** A failed Antigravity tool call may be read as success, which — per
the invariant that a tool's reported success is not success — could merge a
branch where nothing happened. The fatal-error guard in
`subprocess-adapter.ts` only helps if the parser recognises the failure.

**Fix.** Force a failure deliberately: run Antigravity against a read-only
directory, or deny a tool, and capture `.maya/logs/<agent>.ndjson`. Then
encode the real shape and add a parser test from the captured sample. Until
then, treat an Antigravity worker as the least trustworthy of the three.

**Effort.** An hour, mostly waiting on the CLI.

---

## C. Platform and verification

### C1 — Nothing has ever been run on Linux — **OPEN**

**Evidence.** Every command, test and harness in this project ran on Windows.

**Impact.** The brief asks for Windows **and** Linux. The code avoids platform
assumptions and the reasoning is sound, but reasoning is not evidence. Three
specific places would fail first:

- `fs.watch` with `recursive: true` needs Node 20.13 on Linux; below that the
  file watcher reports itself unavailable and the repository tree goes stale.
- `node-pty` has no Linux prebuild, so the `pty` transport and **all five
  verification harnesses** need a C++ toolchain there.
- `findGitBash()` and `resolveExecutable()` are Windows-shaped; they should
  no-op cleanly on Linux, which has never been observed.

**Fix.** Run `pnpm install && pnpm build && pnpm test && pnpm lint` and then
`maya init`, `maya run`, `maya web` on a Linux box. Record what breaks. Add a
CI workflow running the suite on `ubuntu-latest` and `windows-latest` so this
cannot silently regress. Mark the harnesses that need node-pty so they skip
with a clear message rather than failing.

**Effort.** Half a day, and it is the highest-value item here because it
converts a claim into a fact.

### C2 — The `@user` marker has never been used by a live agent — **OPEN**

**Evidence.** Every test of the secret channel publishes the event
synthetically or uses a stub plugin. No real model has chosen to use it.

**Impact.** The plumbing is proven; the behaviour is not. If models ignore the
briefing, the feature is dead weight and nobody will notice.

**Fix.** On the next live run, give a worker a deliberately ambiguous task —
one that cannot be completed correctly without asking — and see whether it
reaches for `@user`. If it does not, the briefing in
`SECRET_CHANNEL_BRIEFING` needs to be stronger or placed differently in the
prompt. Cheap to test as part of a run that was happening anyway.

### C3 — One test is flaky and unidentified — **OPEN**

**Evidence.** One of 144 failed once, during a run where the machine was busy
with leftover daemons; 144/144 and then 151/151 on more than ten subsequent
runs. The failing test's name scrolled past before it was captured.

**Impact.** Small now, corrosive later: a suite that fails occasionally trains
people to rerun instead of read.

**Fix.** Run the suite in a loop under artificial load and capture the name
(`vitest --reporter=json`). The likely candidates are the `eventually()` loops
in the pane and daemon tests, which poll with fixed budgets. The fix is to
wait on a condition with a generous ceiling rather than a short one, or to
make the wait event-driven.

---

## D. Scaling — **FIXED**

`/api/usage` is now served from a running `UsageTracker` the daemon keeps,
seeded once and updated per event. The socket replay and `/api/events` are
capped at 500 by default. The web client folds its derived counters and the
open question in as events arrive instead of rescanning. The measurements
below are what prompted it.


Measured on a seeded 5,000-event session.

| Route | Time | Size | Behaviour |
| --- | --- | --- | --- |
| `/api/usage` | 82 ms | — | rescans the entire log |
| `/api/events?since=0` | 45 ms | **1,095 kB** | unbounded |
| `/api/graph` | 302 ms | — | bounded at 300 commits |
| `/api/files` | 160 ms | — | one `git ls-files` |

**D1 — `/api/usage` is a full-log scan, and the web client refetches it on
every `usage` and `done` event.** Linear in session length, repeated per
event, so quadratic over a session. *Fix:* keep a running `UsageTotals` in the
daemon, updated as events are published, and serve that. The aggregation
function stays for replay and tests.

**D2 — A connecting client replays the whole log.** 1.1 MB at 5,000 events, on
every page load. *Fix:* cap the initial replay (the last N events, or events
after a timestamp) and let the client ask for older history on demand. Same
change makes `/api/events` safe to expose.

**D3 — The web client recomputes derived state on every event.**
`openConflict(events)` and the two `events.filter(...)` counters in `App.tsx`
walk the full array per render. *Fix:* fold them into the reducer that already
appends events, so each event is examined once.

None of these bite a normal session. Do them when a session routinely exceeds
a few thousand events.

---

## E. Ergonomics

**E1 — There is no verified global install.** `pnpm package` produces
`dist/maya`, and `tools/verify/packaged.mjs` proves it runs from an unrelated
directory with only its declared dependencies — but `npm link` / `npm i -g`
has never been run. *Fix:* run it, from a clean shell, on both platforms, and
write the result into the packaged README.

**E2 — Copilot costs a premium request per run** and auto-approves tools it
classifies as safe; a VS Code shim can shadow the real binary on `PATH`.
*Fix:* documentation, not code — `maya doctor` should say which `copilot`
binary it resolved, which is a two-line change to the health check.

**E3 — Worker panes are read-only.** There is no process behind a pane to
receive keystrokes (ADR 0001). *Fix:* none needed unless an adapter with a
genuine interactive session appears; the design note already records it.

---

## What A1 still needs

A3 built `SummaryGenerator`, which is the first thing that runs the Operator's
own adapter — so the pattern for A1 exists now: resolve the operator profile
through the registry, run one bounded turn, parse a typed result, fall back
when anything goes wrong. A1 is the same shape with a task list instead of a
commit message, plus the confirmation step before dispatch.

## Suggested order

1. **B1** — secret text in snapshots. Smallest real fix, and A3 would spread
   the problem if left.
2. **C1** — Linux. Decides whether a headline claim is true.
3. **B2.1** — wire the Claude budget options through. Nearly free.
4. **A3** — real summaries. Small, and immediately visible in git history.
5. **A1** — the planning Operator. The big one; everything above makes it
   safer to add.
6. **A2** — worker→Operator questions, once there is an Operator to ask.
7. **B2.2** — adapter-agnostic run ceiling.
8. **C3**, then **D1–D3** when sessions get long.
9. **B3**, opportunistically, the next time Antigravity fails.

`docs/FINDINGS.md` is the companion to this file: it records the traps already
hit, where this one records the work still outstanding.
