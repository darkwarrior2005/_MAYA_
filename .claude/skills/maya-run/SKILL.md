---
name: maya-run
description: Run and operate Maya itself — start a session, watch it in panes or a browser, run one task through one agent, diagnose a broken setup, and package the CLI. Use when asked to start, run, attach to, serve, or troubleshoot Maya, or to add an adapter for another coding CLI.
---

# Running Maya

Maya is a pnpm workspace. Build before running anything: `pnpm build` compiles
every package and the web client the daemon serves.

## Starting something

```bash
node packages/cli/dist/main.js init <dir>                    # prepare a project
node packages/cli/dist/main.js run "<task>" -d <dir>         # one agent, one branch, then merge
node packages/cli/dist/main.js start --tui "<a>" "<b>" -d <dir>   # several agents, in panes
node packages/cli/dist/main.js web -d <dir>                  # the web interface
node packages/cli/dist/main.js attach -d <dir>               # panes on a session already running
node packages/cli/dist/main.js doctor -d <dir>               # what is installed and logged in
```

One daemon per project, recorded in `.maya/daemon.lock`. `maya start` and
`maya web` each start one; `attach` joins the one already there. Typing
`/localhost` in the pane view opens the browser at the same port.

**`run` and `start` spend real money** — they drive Claude Code, Copilot CLI or
Antigravity against the repository. A measured one-line task cost $0.41. Do not
run them to "see if it works": `maya doctor` answers that for free, and
`tools/verify/` has harnesses that exercise everything except a live model.

## When something is wrong

Start with `maya doctor`. It checks git, the event store, the daemon lock, each
wrapped CLI's install and auth, and any adapter plugins the project configured.

Then read `docs/FINDINGS.md`. It is a list of traps that each cost hours, and
every one of them looks like a different problem when you hit it — a Copilot
run that reports success having done nothing, a Claude Code start that fails
with only "exited with code 1", a pane frame that scrolls the screen.

`.maya/logs/<agent>.ndjson` holds each agent's raw output, which is where a
stall or a mis-parsed stream gets diagnosed.

## Adding support for another coding CLI

A project adds its own adapter by naming a module in `.maya/config.json`;
`docs/adapter-plugin-example.mjs` is a working one, and `docs/adr/0004` covers
the trust model — that list runs the code it names.

Two things a new adapter must get right, both learned the hard way:

- **Emit `done` with the tool's own view of success, not its exit code.**
  Copilot CLI exits 0 even when every tool call was denied.
- **Emit `error` with `fatal: true` for anything meaning the run did not really
  happen.** A fatal error is what stops Maya merging a branch where nothing was
  done.

## Before you say it works

```bash
pnpm test                            # the suite
pnpm lint
node tools/verify/panes.mjs          # the pane view in a real pseudoconsole
node tools/verify/conflict.mjs       # a merge question, answered from a pane
node tools/verify/column-width.mjs   # text widths against a real terminal
node tools/verify/mcp.mjs            # the MCP server over stdio
node tools/verify/packaged.mjs       # the bundle, from an unrelated directory
```

The harnesses need the optional `node-pty`. `docs/PLAN.md` records what each
phase was supposed to prove; `bugfixy.md` records what is still open.
