# bugfixy — what is wrong with Maya now, and how to fix it

A second plan, written after building all six phases of `docs/PLAN.md` and
reviewing the result end to end.

Every issue below was **verified against running code**, not inferred. Where a
number appears, it was measured. Three bugs found in the review are already
fixed (`ca26809`, `4383efb`) and are not repeated here.

Status: 240 tests, lint clean, every verification harness passing, and CI green
on `ubuntu-latest` and `windows-latest`.

**Update.** A1, A2, A3, B1, B2, B4, C1 and D1–D3 are now fixed; an MCP server,
two agent skills and a fourth agent (OpenAI Codex) have been added. What is
left is marked **OPEN** below — B3, C2, and a live run of Codex. The fixed
entries are kept for the reasoning, with what was done.

Building A1 turned up two more defects, both now fixed and both invisible to
the unit tests because they only appear in a real repository:

- **Merging was refused whenever the working tree held an untracked file.**
  `status.isClean()` counts those, so Maya declined to merge in most real
  repositories — and the post-merge check aborted successful merges for the
  same reason. Only changes a merge could actually destroy block it now;
  git itself refuses the one case an untracked file is at risk.
- **Every generated summary silently fell back.** It diffed `base...branch`
  before the commit existed, so the diff was always empty and the summary was
  always the task text. The change is now read from the staged diff.

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

*That was written before any of it was done. All of it is now fixed, C1
included; what is left is B3, C2 and a live run of Codex — all three of which
need a real agent run rather than code.*

---

## A. The Operator does not think

### A1 — The Operator can now split a request — **FIXED**

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

### A2 — A worker has no way to ask the Operator anything — **FIXED**

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

### B4 — The probes credited a run that never happened — **FIXED**

**Evidence.** The first real `maya agents --live` run, 10 November 2026, on
this machine. Claude Code's OAuth session had expired. It came out of that
run **the fastest of the three agents** (1.5s — it failed immediately), was
credited with reporting what it spent (a `usage` event of all zeros), and was
credited with leaving the tree alone (it had not got far enough to touch
anything). Copilot, meanwhile, was marked **FAIL** for resolving to the VS
Code shim, and then wrote the file through that shim in 11.5s.

**Impact.** The Agents page existed precisely so nobody has to take an
opinion on trust. A card that crowns a tool for failing quickly is worse than
no card.

**Fix, applied.** Every live probe whose answer depends on the run having
happened now reports `skipped` when it did not, and `scoreFrom` leaves the
corresponding bar unmeasured instead of full. `ProbeOutcome` gained `warn`
for a finding that is a caution rather than a failure, which is what a shim
is. The error is classified before it is reported, so an expired login no
longer prints the advice about permissions. Six checks in
`tools/verify/agents.mjs` hold this down, driven by an `expired-agent`
stand-in that reproduces the exact shape.

**What the figures actually were.** Copilot CLI 9/9, wrote the file in 11.4s,
30,566 tokens, obeyed "change nothing". Antigravity CLI 9/9, 60.1s, 41,290
tokens, obeyed. Claude Code 4/5 static, every live probe skipped: log in and
re-run.

**Two more the same run exposed.** "Logged in" was a pass for all three while
none of them can actually check it — the expired Claude Code session passed
that probe twice. `AdapterHealth` carries `verified` now, and an assumed login
is amber. And the speed scale bottomed out at 60s, so Antigravity's working
60.1s run scored **0**; the floor is the probe timeout now, where 0 means
"only just finished in time". Three more checks in
`tools/verify/agents.mjs`, 24/24.

---

## C. Platform and verification

### C1 — Nothing has ever been run on Linux — **FIXED**

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

**Fixed.** `.github/workflows/ci.yml` runs the suite on `ubuntu-latest` and
`windows-latest`, and both legs are green: install, build, lint, 240 tests,
MCP 17/17, agent probes 24/24, packaged bundle 12/12, panes 23/23. None of the
three predictions above is what actually broke. What did, in the order the
runs found it:

1. **`maya init` cannot run on a machine with no git identity.** A real bug,
   not a test artifact: a fresh runner has no `user.name` or `user.email`, and
   `openOrInit` makes an empty first commit because branch operations need a
   HEAD. The suite could never have caught it — `makeTempRepo` configures an
   identity, so the tests exercised a machine the real command never meets.
   `openOrInit` checks first and names the two commands to run; `maya doctor`
   has its own line for it.
2. **`core.autocrlf=true` on GitHub's Windows runners**, which turned a
   committed `docs\n` into `docs\r\n` and failed two content assertions. Test
   repositories set it false.
3. **`pathToFileURL` percent-encodes the tilde** in the 8.3 short name
   `RUNNER~1`, and Vite's resolver does not decode it. The real CLI loads a
   plugin from such a path — checked by hand — so this was vitest's import
   path, never Maya's. Test temp directories go through `realpathSync.native`.
4. **A size-and-mtime snapshot is not a file fingerprint.** The restraint
   probe missed a same-length edit between two instant runs, because Windows
   stamps writes from a clock that advances about every 15ms. It hashes the
   bytes now. The harness was also asserting the probe catches a
   byte-identical rewrite, which no before/after comparison can see.
5. **A pty is not a terminal.** `column-width.mjs` wants a cursor-position
   report, which comes from the screen emulator — ConPTY answers, a bare
   Linux pty has nothing behind it. It reports SKIPPED there instead of
   calling all fourteen samples a mismatch. node-pty **does** build on the
   runner, so skipping on its absence was the wrong test.

Two of the five were real defects and three were the checks being wrong about
the machine. That ratio is the argument for running this in CI rather than
once by hand.

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

### C3 — One test is flaky and unidentified — **FIXED**

**Evidence.** One of 144 failed once, during a run where the machine was busy
with leftover daemons; 144/144 and then 151/151 on more than ten subsequent
runs. The failing test's name scrolled past before it was captured.

**Impact.** Small now, corrosive later: a suite that fails occasionally trains
people to rerun instead of read.

**Fixed.** The culprit was `"still runs different workers at the same time"`,
which proved parallelism by asserting two 120ms tasks finished inside 2000ms.
Measured, the git work alone left about 350ms of margin, and observed totals
were 1644ms, 1789ms and 2241ms — so the test failed whenever the machine was
busy, which is also when it is least convincing. It compares the two runs'
spans for overlap now: a structural claim about concurrency instead of a bet
on a wall clock.

One correction to how this was chased. A second "intermittent failure" I went
looking for afterwards did not exist. The loop I was running piped vitest
through `grep`, which exits 1 when nothing matches, and ANSI colour codes meant
the pattern never matched — so the exit code was grep's, not vitest's. Four
full captured runs came back 238/238. The lesson is narrower than "the suite is
flaky": **check what the exit code belongs to before believing it.** The
related 11/24 from `tools/verify/agents.mjs` was also not a flake — it was port
contention with daemons the suite had not finished closing. That harness
binding a fixed port 7991 is a real fragility, still unaddressed.

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

**E1 — There is no verified global install.** — **FIXED.** `install.sh` and
`install.ps1` build the bundle, put a `maya` command on `PATH` and then run
the installed command to prove it works; `README.md` is the install guide for
both platforms. Verified by hand on Windows. The Linux script has not been
run on a real Linux machine — CI exercises the suite and the packaged bundle
there, not the installer.

**E2 — Copilot costs a premium request per run** and auto-approves tools it
classifies as safe; a VS Code shim can shadow the real binary on `PATH`.
*Fix:* documentation, not code — `maya doctor` should say which `copilot`
binary it resolved, which is a two-line change to the health check.

**E3 — Worker panes are read-only.** There is no process behind a pane to
receive keystrokes (ADR 0001). *Fix:* none needed unless an adapter with a
genuine interactive session appears; the design note already records it.

---

## How A1 landed

`orchestrator/planner.ts` runs the Operator's own adapter over one request and
parses a `TASK:` list, capped at six. `Operator.planAndRun` puts the split to
the person as the same question type a blocked merge uses — so it renders in
the panes and in the browser with no new machinery — and runs what they chose:
the plan, the request whole, or their own words.

Everything degrades to today's behaviour: no operator configured, a tool that
is unavailable, an unparseable answer, or a model echoing the template back
all fall back to one task carrying the request verbatim.

`--plan` refuses up front when there is nobody to confirm — with `--yes`, or
with a non-interactive stdin. The second guard exists because the first live
run hung forever on a piped stdin waiting for an answer that could never come.

Verified by `node tools/verify/planning.mjs`, which drives
`maya start --plan` in a real pseudoconsole and answers it three ways.

## Suggested order

This was the plan, and it was followed: B1, C1, B2.1, A3, A1, A2, B2.2, C3 and
D1–D3 are all done, in roughly that sequence.

What remains cannot be done by writing code. Both need a live agent:

1. **C2** — whether a live model reaches for `@user` (and now `@operator`)
   when a task is deliberately ambiguous. Free as part of a run that was
   happening anyway.
2. **B3** — Antigravity's failure shape, opportunistically, the next time it
   fails. Keep `.maya/logs/<agent>.ndjson` when it does.

**Codex has now been run** (codex-cli 0.167.1, 9/9 live probes). Worth
recording what that cost, because it is the argument for doing the same to
B3: the parser written from documentation was correct in every field but one,
and the run still found four bugs — three of them in shared code that had
nothing to do with Codex. `where` listing an npm shim Windows cannot spawn
ahead of the `.cmd`; `shell: true` concatenating arguments unescaped, so every
multi-word prompt to any `.cmd`-resolved tool was corrupted; and a live-probe
workspace that was not a git repository, which made Codex's refusal to work
outside version control look like a permissions failure. See
`docs/FINDINGS.md`.

Smaller and unaddressed: `tools/verify/agents.mjs` binds a fixed port 7991, so
it reports spurious failures when run immediately after the suite.

`docs/FINDINGS.md` is the companion to this file: it records the traps already
hit, where this one records the work still outstanding.
