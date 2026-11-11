# Maya — build plan and status

Maya is a cross-platform (Windows + Linux) orchestration tool where several
existing AI coding CLIs work together under one **Operator agent**. The Operator
assigns tasks, keeps the git history, and has the only say over what lands.
**Worker agents** create branches and scripts but never merge.

Status as of 2026-11-11: **Phases 0–6 complete.** The plan is built, and CI is
green on Linux and Windows. What is left is in "Still open" at the end; it
needs a live agent run rather than code.

---

## What the finished thing looks like

Two interfaces over one session. Both are WebSocket clients of the same
per-project daemon, so they are two views of one event log rather than two
programs.

**CLI** (`docs/cli-panes.txt` is a real capture) — tmux-style: the Operator in
the main pane, workers in panes below, one prompt line. `/localhost` opens the
web interface.

**Web** — three columns: Git Tree with a status box (left), repository file
browser (middle), AI chat showing Operator→worker delegation and
"resolve this tie, user" prompts with options plus a free-text answer (right).
Below: an "Agents To Do" panel, a "Secret Channel to User" sub-panel, an
Agents/Sub-Agents roster, and an Info Panel with token and per-model usage.

From the original brief, and still binding:

- The Operator delegates, summarises, maintains the repository, and decides what
  merges. Other agents may create scripts and branches; they do not merge.
- The Operator can ask the user new questions. Sub-agents ask the Operator.
- **Secret channel**: in specific situations any agent may reach the user
  directly instead of going through the Operator. It is a separate lane in the
  same chat (`channel: "secret"`), not a separate transport.
- Every agent persists its context as paired **HTML and Markdown** files.
- All inter-agent communication flows through one chat system that both
  interfaces render.
- Runs from any terminal, on Windows and Linux.

---

## Phases

### Phase 0 — Scaffolding — **done**
pnpm workspace, `tsconfig.base.json`, `shared-types`, eslint + vitest.

### Phase 1 — Headless single-agent core — **done**
Claude Code adapter (in-process SDK), `repo-manager` + `branch-manager`,
`event-store` + `event-bus`, and `maya run <task>` driving one agent end to end:
branch → run → context snapshot → commit → merge.

*Verified*: a disposable repo gets a `maya/<task>/<agent>` branch, commits land
on it, `.maya/state.db` and `.maya/agents/.../latest.md|.html` are written, and
`main` receives the merge.

### Phase 2 — Multi-agent + Operator — **done**
`operator.ts` + `task-queue.ts`; Copilot CLI and Antigravity CLI adapters;
`conflict-resolver.ts`; parallel workers in separate git worktrees; the daemon
and its WebSocket hub; `maya start`; `maya doctor`.

*Verified*: two workers concurrently on independent subtasks, with assignment,
completion and merge order in `.maya/state.db`; a stub adapter that never emits
is killed by the watchdog; the event store runs in WAL mode under concurrent
writes. All three adapters were then exercised against their real CLIs.

### Phase 3 — CLI pane view — **done**
`cli/src/tui/`: layout, pane state, screen, keys, bus client, slash commands.
`maya start --tui`, `maya attach`, `/localhost`.

The panes render the normalized event stream rather than hosting a PTY per
agent — see `docs/adr/0001-cli-panes-render-bus-events.md` for why, and what
that costs.

*Verified*: `node tools/verify/panes.mjs` (23 checks in a real pseudoconsole:
panes, replay, keys, slash commands, escape-code stripping, resize in both
directions, terminal restored) and `node tools/verify/live-run.mjs` (11 checks
driving a real Claude Code run through the panes).

### Phase 4 — Web server + read-only UI — **done**
`core/src/git/graph-builder.ts` (commit DAG with lanes assigned server-side)
and `file-tree.ts` (the repository as git sees it); `core/src/daemon/http-api.ts`
and `file-watcher.ts`; `packages/web-client` (React + Vite): Git Tree with a
status box, repository browser, and chat, all reading the one event log.
`maya web` serves it, `maya start --tui` serves it on the same port, and
`/localhost` opens it.

The daemon serves the API, the client and the WebSocket on one port, without a
web framework — see `docs/adr/0003`. Transient signals were split from durable
events in the same decision.

*Verified* against a seeded repository with two task branches and a merge: the
git tree matches `git log --graph --topo-order` commit for commit and lane for
lane; a file written on disk appears in the browser with no reload; a line
typed in an attached pane appears in the web chat and one sent from the browser
lands in the same log; and killing the daemon, publishing while it is down and
restarting it leaves the open browser with both missed lines, no duplicates and
no gap.

### Phase 5 — Secret channel + full chat, roster, info panels — **done**
`core/src/orchestrator/secret-channel.ts`, `core/src/usage/token-tracker.ts`,
`/api/usage` and `/api/conflict`, and the web client's `ConflictPrompt.tsx`
and `Panels.tsx` (Agents To Do, Secret Channel, Agents roster, Info).

**How the secret channel works.** A wrapped CLI has one way to say anything:
the text it prints. So the channel is a marker in that text — a line beginning
`@user` is lifted out and published on `channel: "secret"`, and the rest stays
in the Operator's transcript. The briefing that tells an agent the marker is
appended to every instruction, because an agent cannot use a channel it was
never told about. The web shows the secret lane in its own panel and
deliberately *not* in the main chat, which is the whole point of it.

**How a merge question is answered.** One `DeferredConflictResolver` per
session, whatever the interface. The prompt is rendered from the event stream
rather than from the resolver object, so an attached pane in another process
shows the same question with the same options; both the pane and the browser
answer it by posting to `/api/conflict`, and whichever gets there first wins —
the other is told it was already answered.

*Verified*: `node tools/verify/conflict.mjs` drives a real pane (the question,
its options, who proposed them, answering with `2`, the banner clearing, the
decision landing in the transcript); the browser answers the same question
with a button click and the Operator's promise resolves to `discard`; a
worker's `@user` line reaches the Secret Channel panel and never appears in
the Operator's chat.

### Phase 6 — Hardening — **done**
`core/src/adapters/plugin-loader.ts` and `loadRegistry()`;
`core/src/daemon/recovery.ts`; `tools/package.mjs`.

**Adapter plugins.** A project names a module in `.maya/config.json` and Maya
imports it, so a tool can be added without changing Maya. See
`docs/adapter-plugin-example.mjs` for a working one, and `docs/adr/0004` for
the trust model — in short, the `adapters` list is as trusted as the
repository it sits in, it is empty by default, and every module path is
printed as it loads.

**Recovery.** Every daemon start clears a lock whose process is gone, moves
tasks a dead process left `running` to `blocked`, and prunes git's metadata
for worktrees that are already gone. A worktree still on disk is reported and
never deleted: that is exactly where a crash leaves uncommitted work.

**Packaging.** `pnpm package` bundles the CLI with esbuild into `dist/maya`,
with the web client beside it and a manifest naming only the dependencies that
cannot be inlined.

*Verified*: `node tools/verify/packaged.mjs` (12 checks — the bundle copied to
a temp directory with only its declared dependencies, driven from an unrelated
cwd: `--help`, `init`, `doctor` loading the native sqlite module, and `web`
serving the packaged client); a daemon killed mid-flight, after which the next
start cleared the lock and moved the orphaned task to blocked; and a project
plugin loaded by `maya doctor` and used by `maya run` to take a task through
branch, commit and merge.

## Settled

**Linux runs Maya.** This was the open item that mattered most, and it is now
a fact rather than an argument. `.github/workflows/ci.yml` runs the suite on
`ubuntu-latest` and `windows-latest`, and both legs are green: install, build,
lint, 240 tests, the MCP server (17/17), the agent probes (24/24), the
packaged bundle (12/12) and the panes (23/23). Two things the first runs
turned up are worth keeping in mind:

- node-pty **does** build on a Linux runner, so the pane harness is a real
  check there too. It stays an optional dependency because requiring it would
  put a C++ toolchain in the path of every Linux install, not because the
  terminal code is unexercised.
- `column-width.mjs` is Windows-only in substance. It asks the terminal for a
  cursor-position report, which comes from whatever emulates the screen;
  ConPTY answers, a bare Linux pty has nothing behind it to answer. It reports
  SKIPPED there rather than claiming fourteen width mismatches.

Keeping it green is the point of the workflow. `docs/FINDINGS.md` records what
the first three runs cost to learn.

## Still open

- **No live run of Codex.** The adapter and its JSONL parser were built from
  OpenAI's published interface, not from a session — the one adapter of the
  four never driven against its real CLI. `npm i -g @openai/codex`,
  `codex login`, then `maya agents -d <dir> --live` settles it.
- **The `@user` marker is untested with a live agent.** The plumbing is
  tested, but whether a model reaches for it when it should is a prompting
  question. Watch it on the next live run.
- **Antigravity's tool-failure shape** is still inferred; no failing sample
  has turned up.

## Deferred, deliberately

- **Cost budgets.** Not enforced in v1. The Claude Code adapter already accepts
  `maxTurns` and `maxBudgetUsd`; Copilot and Antigravity have no equivalent, so
  a denied agent can burn several turns retrying before giving up, and the stall
  watchdog will not catch it because output keeps arriving.
- **Typing into a worker pane.** There is no process behind a worker pane to
  receive keystrokes (ADR 0001). A future adapter with a genuine interactive
  session could be given a pane that hosts it.
- **Antigravity's tool-failure shape.** Inferred from reaching `DONE` without an
  error, because no failing sample was available. Confirm it when one appears.
