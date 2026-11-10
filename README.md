# Maya

Several AI coding CLIs working together on one repository, under one **Operator**
agent that assigns the work, keeps the git history, and has the only say over
what lands. Workers create branches; they never merge.

One command, two views of the same session: a terminal pane view and a web
interface, both reading the same event log.

```
┌─ Operator ───────────────────────────────────────────┐
│ >> worker-claude: add the CSV importer [maya/a1/..]  │
│ ?? worker-copilot asks: does the file have a header? │
│ -> yes, assume a header row                          │
│ merged maya/a1b2c3d4/worker-claude                   │
├─ Worker (Claude) ──────┬─ Worker (Copilot) ──────────┤
│ [tool] Write           │ wrote parser.ts             │
│ importer.ts created    │ running the tests           │
└────────────────────────┴─────────────────────────────┘
```

---

## Install

You need three things before you start, on either platform:

| | Why | Check |
| --- | --- | --- |
| **Node 20 or newer** | Maya is a Node program. Developed on 25. | `node --version` |
| **git** | Maya drives it; branches and worktrees are the whole design. | `git --version` |
| **pnpm** | The workspace uses it. The installer will enable it through corepack if it can. | `pnpm --version` |

Everything else the installer does for you.

### Linux and macOS

```bash
git clone https://github.com/darkwarrior2005/_MAYA_.git
```

```bash
cd _MAYA_ && chmod +x install.sh && ./install.sh
```

That installs `maya` and `maya-mcp` into `~/.local/bin` and adds that directory
to your PATH if it is not there already. Open a new shell afterwards, or:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Options:

```bash
./install.sh --prefix /usr/local   # somewhere else (may need sudo)
```

```bash
./install.sh --no-path             # install, but leave my shell profile alone
```

### Windows

```powershell
git clone https://github.com/darkwarrior2005/_MAYA_.git
```

```powershell
cd _MAYA_; .\install.ps1
```

That installs `maya.cmd` and `maya-mcp.cmd` into
`%LOCALAPPDATA%\Programs\maya\bin` and adds that directory to your **user**
PATH. Open a new terminal afterwards. Nothing needs an administrator.

If PowerShell refuses to run the script:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Options:

```powershell
.\install.ps1 -NoPath                        # install, but leave PATH alone
```

```powershell
.\install.ps1 -Prefix D:\tools\maya          # somewhere else
```

### Did it work?

```bash
maya --version
```

The installer runs that check itself and tells you if it failed, so if it
printed a version you are done.

### Uninstalling

Delete the shims and the clone. Nothing else is written outside them, except
the PATH line the installer added — which it marks with a comment on
Linux/macOS (`# added by Maya's install.sh`) and which on Windows you remove
from your user PATH.

Per-project state lives in that project's own `.maya/` directory, so removing a
project removes its Maya state with it.

---

## First run

Each wrapped CLI signs in once, per machine, with its own tool. Maya never
handles those credentials:

```bash
claude login       # Claude Code
```

```bash
copilot login      # GitHub Copilot CLI
```

```bash
agy login          # Google Antigravity CLI — interactive
```

```bash
codex login        # OpenAI Codex CLI
```

You do not need all four. Maya runs with whatever is logged in, and tells you
what is missing:

```bash
maya doctor -d .
```

Then prepare a project and give it something to do:

```bash
maya init ~/some-project
```

```bash
maya start --tui "add a CSV importer with tests" -d ~/some-project
```

Or watch it in a browser instead of in panes:

```bash
maya web -d ~/some-project
```

> Agent runs cost money — these are the real CLIs, on your own accounts. Maya
> never passes a bypass-permissions flag to any of them: the defaults are
> `acceptEdits` for Claude Code, `write` for Copilot, `--mode accept-edits` for
> Antigravity, and the `workspace-write` sandbox for Codex. If you want more
> than that, you set it per worker in `.maya/config.json`.

---

## The commands

| | |
| --- | --- |
| `maya init <dir>` | Prepare a project. Writes `.maya/`, excluded via `.git/info/exclude`. |
| `maya doctor -d <dir>` | What is installed, what is logged in, what is running. |
| `maya run "<task>" -d <dir>` | One agent, one branch, no Operator. The simplest thing that works. |
| `maya start --tui "<task>" -d <dir>` | A full session in the pane view. |
| `maya attach -d <dir>` | Panes onto a session already running. |
| `maya web -d <dir>` | The web interface, and opens a browser at it. |
| `maya agents -d <dir>` | Test each configured agent and write a scorecard. |
| `maya agents -d <dir> --live` | ...by giving each one a real task. **This spends money.** |

Inside the pane view, `/localhost` opens the web interface on the same session.
`/quit` leaves.

### What `maya agents` is for

Maya measures the tools it drives rather than taking anyone's word for them.
The static checks cost nothing. `--live` gives each agent a real task in a
throwaway directory and watches what it does — whether it can edit a file with
the permissions Maya grants by default, whether it leaves the tree alone when
told to, how long it took, what it spent. The results land on the Agents page
in the web interface (`#/arena`), one character sheet per agent.

A probe whose run failed reports **not measured**, never a figure. An early
version scored a tool whose login had expired as the fastest of three, because
it failed in 1.5s — see `docs/FINDINGS.md`.

---

## Driving Maya from another agent

`maya-mcp` is an MCP server over stdio, installed alongside `maya`. Point any
MCP client at it with `MAYA_PROJECT` set to the repository Maya is managing:

```json
{ "command": "maya-mcp", "env": { "MAYA_PROJECT": "/path/to/project" } }
```

It can read the session, post to the shared chat, reach you directly on the
secret channel, and answer the Operator's merge questions. It deliberately
cannot queue work — the Operator decides what runs.

In a checkout of this repository, `.mcp.json` registers it already, and
`.claude/skills/` holds two skills: `maya-run` (operate Maya) and
`maya-session` (take part in a running session).

---

## How it fits together

```
your repo/
  .maya/
    config.json        which agents, which models, which permissions
    state.db           the append-only event log
    daemon.lock        pid + port of the running daemon
    agents/<id>/*.md   paired .md/.html context snapshots
    logs/<id>.ndjson   raw adapter output, for when something stalls
```

One daemon per project owns the event log and serves both views on one port.
The terminal and the browser are both WebSocket clients of it, and both replay
from their last-seen event id on connect — so a dropped socket cannot leave a
view quietly stale.

A worker runs in its own git worktree on `maya/<task>/<agent>`. The Operator
merges, one branch at a time, and a merge it cannot make cleanly becomes a
question for you in whichever view you are looking at.

| Package | Owns |
| --- | --- |
| `packages/shared-types` | The event and payload types. No logic. |
| `packages/core` | Adapters, orchestrator, git, the event bus, the daemon, agent probes. |
| `packages/cli` | The commands and the pane view. |
| `packages/web-client` | React + Vite: git tree, file browser, chat, Agents page. |
| `packages/mcp-server` | Maya as an MCP server. |

Adding another coding CLI means writing one adapter and naming it in
`.maya/config.json`; `docs/adapter-plugin-example.mjs` is a working one. No
orchestrator code branches on which tool an agent is.

---

## Building from source

The installer does all of this; this is what it runs.

```bash
pnpm install && pnpm build
```

```bash
pnpm test          # 217 tests
```

```bash
pnpm lint
```

```bash
pnpm package       # bundles a self-contained maya into dist/maya
```

Verification that cannot be a unit test drives real terminals, a real daemon
and the real packaged bundle:

```bash
node tools/verify/agents.mjs       # the agent probes, against misbehaving stand-ins
```

```bash
node tools/verify/mcp.mjs          # the MCP server over stdio, against a daemon
```

```bash
node tools/verify/packaged.mjs     # the bundle, driven from an unrelated cwd
```

```bash
node tools/verify/panes.mjs        # 23 checks in a real pseudoconsole
```

The pseudoconsole harnesses need the optional `node-pty`, which has no Linux
prebuild. Without it they print `SKIPPED` and exit 0 rather than failing.

For hot reload on the web client, run a daemon with `maya web`, then:

```bash
MAYA_PORT=<its port> pnpm --filter @maya/web-client dev
```

---

## Where to read next

- **`docs/PLAN.md`** — the target, what is built, what is still open.
- **`docs/FINDINGS.md`** — every trap that cost hours, and what it actually
  was. Read this before touching an adapter, the terminal code, or a
  dependency version.
- **`docs/adr/`** — the decisions that went against the original plan, with
  the reasoning.
- **`CLAUDE.md`** — the seventeen invariants. Breaking one is a correctness
  bug, not a style question.
- **`bugfixy.md`** — the issues found by reviewing the build, and their state.

**Known gap:** Maya was built and tested on Windows. The code avoids platform
assumptions and `.github/workflows/ci.yml` runs the suite on `ubuntu-latest`
and `windows-latest`, but until that workflow has run, Linux support is
reasoning rather than evidence. If `./install.sh` breaks on your machine, that
is worth an issue.
