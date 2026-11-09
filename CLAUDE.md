# Maya

Several existing AI coding CLIs working together under one **Operator agent**.
The Operator assigns tasks, keeps the git history, and has the only say over
what lands. **Workers** create branches and scripts but never merge. One CLI
interface and one web interface are two views of a single event log.

**Read `docs/PLAN.md` first** — it holds the target, the phase status and what
the next phase has to do. **Read `docs/FINDINGS.md` before touching an adapter,
the terminal code, or a dependency version**; it is a list of traps that each
cost hours and every one of which looks like a different problem when you hit
it. `docs/adr/` holds decisions that went against the original plan, with the
reasoning.

All six phases of `docs/PLAN.md` are built. What is left is listed under
"Still open" there — chiefly that **nothing has been run on Linux**.

## Commands

```bash
pnpm install          # pnpm 12; node >= 20 (developed on 25)
pnpm build            # tsc -b across the workspace
pnpm test             # vitest
pnpm lint             # eslint
pnpm package          # bundle the CLI into dist/maya
```

```bash
node packages/cli/dist/main.js init <dir>              # prepare a project
node packages/cli/dist/main.js doctor -d <dir>         # per-tool install/auth
node packages/cli/dist/main.js run "<task>" -d <dir>   # one agent, one branch
node packages/cli/dist/main.js start --tui "<task>" -d <dir>
node packages/cli/dist/main.js attach -d <dir>         # panes on a live session
node packages/cli/dist/main.js web -d <dir>           # web interface, opens a browser
```

The web client is a Vite app; `pnpm build` builds it and the daemon serves it.
For hot reload, run a daemon with `maya web`, then
`MAYA_PORT=<its port> pnpm --filter @maya/web-client dev`.

Verification that cannot be a unit test lives in `tools/verify/` and needs the
optional `node-pty`:

```bash
node tools/verify/panes.mjs      # 23 checks in a real pseudoconsole
node tools/verify/conflict.mjs   # a merge question in a pane, answered
node tools/verify/column-width.mjs  # width.ts against a real terminal
node tools/verify/mcp.mjs        # the MCP server over stdio, against a daemon
node tools/verify/live-run.mjs   # a real agent run; costs money
node tools/verify/packaged.mjs   # the bundle, driven from an unrelated cwd
```

`.claude/skills/` holds two skills for agents working here: `maya-session`
(take part in a running session) and `maya-run` (operate Maya itself).
`.mcp.json` registers the MCP server for this repository; elsewhere, point a
client at `maya-mcp` with `MAYA_PROJECT` set to the managed repository.

A project can add its own adapter by naming a module in `.maya/config.json`;
`docs/adapter-plugin-example.mjs` is a working one. That list runs the code it
names — see `docs/adr/0004`.

## Layout

| Package | Owns |
| --- | --- |
| `packages/shared-types` | `AgentEvent`, `BusEvent`, `ChatPayload`, `TaskSpec`, `GitNode`, `TokenUsage`. No logic. |
| `packages/core/src/adapters` | One `AgentAdapter` per wrapped CLI, normalising to `AgentEvent`. Plus the stall watchdog and PATH resolution. |
| `packages/core/src/orchestrator` | `Operator` (dispatch and merge), `TaskQueue`, conflict resolvers, `TaskRunner` (the single-task chain). |
| `packages/core/src/git` | Repo, branch, worktree and merge services over `simple-git`. |
| `packages/core/src/bus` | Append-only SQLite event log and the in-process bus. |
| `packages/core/src/daemon` | One daemon per project: owns the bus, serves `/ws`, the HTTP API and the built web client on one port, watches the repository, writes `.maya/daemon.lock`. |
| `packages/core/src/persistence` | Paired `.md`/`.html` context snapshots. |
| `packages/core/src/usage` | Rolls the event log up into per-agent and per-model totals. |
| `tools/` | `package.mjs` bundles the CLI; `verify/` holds the checks that cannot be unit tests. |
| `packages/cli/src/commands` | `init`, `run`, `start`, `attach`, `doctor`. |
| `packages/cli/src/tui` | The pane view. `layout.ts` is pure; `screen.ts` owns the terminal; `pane-state.ts` routes events; `bus-client.ts` is the socket. |
| `packages/mcp-server` | Maya as an MCP server over stdio, so another agent can read the session, post to it, reach the person, and answer the Operator. Talks to the daemon over HTTP like any other client. |
| `packages/web-client` | React + Vite: git tree, repository browser, chat. Built to `dist`, served by the daemon. Imports `@maya/shared-types` only — never `@maya/core`, which pulls native modules. |

Per-project state lives in `<repo>/.maya/` — `config.json`, `state.db`,
`daemon.lock`, `agents/<id>/*.md|.html`, `logs/<id>.ndjson`.

## Invariants

Sixteen rules. Breaking one of these is a correctness bug, not a style question. Most are here
because they were broken once already.

1. **The Operator alone merges.** A stalled or failed worker's branch is never
   merged, and a blocked merge becomes a question for the user — never a forced
   merge and never a task marked done on a dirty tree.
2. **A tool's reported success is not success.** A recorded fatal error
   overrides it, and so does a stall. See `subprocess-adapter.ts`.
3. **Pipe transport stays the default** for subprocess adapters. A PTY corrupts
   the long JSON lines these tools emit, and the corruption looks like success.
4. **No bypass-permission flags by default**, for any tool.
5. **Everything an agent does goes through the bus** before it reaches a screen.
   The CLI and the web client are WebSocket clients of the daemon, and both
   replay from their last-seen event id on connect, so a dropped socket cannot
   leave a view silently stale.
6. **Only the daemon's process writes to the bus.** Another process can open
   the same SQLite file, but the daemon's emitter is what notifies views, and
   clients resume from their own high-water mark — so a row written from
   outside is skipped permanently, not caught up later. Anything else that
   needs to say something posts to `/api/message`.
7. **A merge question is answered through the daemon**, by the pane and the
   browser alike, and rendered from the event stream rather than from the
   resolver — otherwise a view in another process can show the question but
   not answer it.
8. **Durable events and transient signals stay apart.** An event is a row in
   the log, replayable by id. A signal (`files_changed`) says only "re-read
   it" and is never stored.
9. **The daemon checks `Origin`.** Loopback is not access control: a page on
    any other origin can open a WebSocket to localhost and read everything,
    and can POST cross-origin where CORS hides only the response. Both were
    demonstrated against a running daemon before `daemon/origin.ts` existed.
10. **Agent text is untrusted** for rendering: strip escape sequences before
    it is drawn.
11. **Every line the layout emits is exactly `cols` columns wide and contains
    no escape sequences.** Columns, not characters: measure with
    `displayWidth`, never `.length`. Where a terminal's rules are unknown,
    err wide — a gap is harmless, a wrap scrolls the screen.
12. **A run is bounded three ways**, not one: silence, wall clock and tokens.
    Silence alone misses the opposite failure — a denied or looping agent
    keeps talking, so the stall timer is re-armed forever while the run
    spends.
13. **One worker runs one task at a time.** Workers run in parallel, but a
    worker with several tasks works through them in order: concurrent runs of
    one agent share a log file, a pane and a context snapshot.
14. **`.maya/` is excluded via `.git/info/exclude`**, never the user's own
    `.gitignore`.
15. **Context snapshots are written temp-then-rename with retries**, and a
    failed snapshot logs and skips rather than crashing the daemon.
16. **Recovery never deletes a worktree.** A daemon that crashed mid-run
    leaves uncommitted agent work in one; recovery reports it and prunes only
    metadata for directories that are already gone.

## Conventions

- TypeScript strict, plus `exactOptionalPropertyTypes` and
  `noUncheckedIndexedAccess`. Optional properties are added with a conditional
  spread — `...(x ? { x } : {})` — not assigned `undefined`.
- ESM with `NodeNext`: import specifiers carry the `.js` extension even in
  TypeScript source. `verbatimModuleSyntax` is on, so type-only imports need
  `import type`.
- Comments explain **why**, especially where the obvious implementation is
  wrong. They are the only record of most of `docs/FINDINGS.md` at the point
  where it matters. Do not delete one without checking what it is protecting.
- Tests exercise the real thing — real git repos, real subprocesses, a real
  daemon over a real socket — because the defects that actually shipped were all
  in the seams that stubs paper over. Pure logic (layout, routing, key decoding)
  is tested as pure functions.
- Keep an orchestration decision out of the adapters: they normalise events and
  nothing else. No orchestrator code branches on which tool an agent is.
