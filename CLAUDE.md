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

Phases 0–4 are done; Phase 5 (secret channel, conflict UI, roster and info
panels) is next.

## Commands

```bash
pnpm install          # pnpm 12; node >= 20 (developed on 25)
pnpm build            # tsc -b across the workspace
pnpm test             # vitest, 87 tests
pnpm lint             # eslint
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
node tools/verify/live-run.mjs   # a real agent run; costs money
```

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
| `packages/cli/src/commands` | `init`, `run`, `start`, `attach`, `doctor`. |
| `packages/cli/src/tui` | The pane view. `layout.ts` is pure; `screen.ts` owns the terminal; `pane-state.ts` routes events; `bus-client.ts` is the socket. |
| `packages/web-client` | React + Vite: git tree, repository browser, chat. Built to `dist`, served by the daemon. Imports `@maya/shared-types` only — never `@maya/core`, which pulls native modules. |

Per-project state lives in `<repo>/.maya/` — `config.json`, `state.db`,
`daemon.lock`, `agents/<id>/*.md|.html`, `logs/<id>.ndjson`.

## Invariants

Eleven rules. Breaking one of these is a correctness bug, not a style question. Most are here
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
7. **Durable events and transient signals stay apart.** An event is a row in
   the log, replayable by id. A signal (`files_changed`) says only "re-read
   it" and is never stored.
8. **Agent text is untrusted** for rendering: strip escape sequences before it
   is drawn.
9. **Every line the layout emits is exactly `cols` wide and contains no escape
   sequences**, so a line's length is its visible width.
10. **`.maya/` is excluded via `.git/info/exclude`**, never the user's own
    `.gitignore`.
11. **Context snapshots are written temp-then-rename with retries**, and a
    failed snapshot logs and skips rather than crashing the daemon.

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
