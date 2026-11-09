# Maya — build plan and status

Maya is a cross-platform (Windows + Linux) orchestration tool where several
existing AI coding CLIs work together under one **Operator agent**. The Operator
assigns tasks, keeps the git history, and has the only say over what lands.
**Worker agents** create branches and scripts but never merge.

Status as of 2026-11-09: **Phases 0–3 complete. Phase 4 is next.**

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

### Phase 4 — Web server + read-only UI — **next**
`packages/web-server` (Fastify, `@fastify/static`, `ws` on the same HTTP server)
and `packages/web-client` (React + Vite), three columns: Git Tree, repository
browser (chokidar-driven live FS tree), and chat reading the same bus stream the
panes show. Conflict resolution stays CLI-only in this phase.

Needs `core/git/graph-builder.ts`, which is **not written yet**: compute the
commit DAG from `git log --all --parents` and assign lanes server-side, so the
client only draws. Do not reach for `@gitgraph/js`; it has weak adoption.

The daemon currently serves one JSON status route and `/ws`. `/localhost`
already opens the daemon's address, so pointing the web app at that same port
is what turns the existing slash command into a real destination.

*To verify*: the Git Tree matches `git log --graph` for the same repo; the
browser reflects live file changes; a message typed in the CLI appears in the
web chat and vice versa; killing and reopening the web client replays missed
events from the last-seen id with no gap and no duplicates.

### Phase 5 — Secret channel + full chat, roster, info panels
`channel: "secret"` end to end (a split lane in the panes, `SecretChannel.tsx`
in the web client), `AgentsToDo.tsx`, `AgentsRoster.tsx`, `InfoPanel.tsx`, and
the full button-plus-custom-answer conflict UI replacing the CLI-only resolver.

The bus, the payload types (`ChatChannel`, `conflict_prompt`), the task queue
and the per-agent usage totals all exist already; this phase is mostly UI over
data that is already flowing.

*To verify*: two workers edit the same lines; the merge is blocked, the task is
not marked done on a dirty tree, and the same `conflict_prompt` renders in both
interfaces; a worker posting on the secret channel reaches the user without
passing through the Operator's main chat.

### Phase 6 — Hardening
Adapter plugins loaded from `.maya/config.json`, Windows and Linux packaging,
daemon crash and re-attach.

---

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
