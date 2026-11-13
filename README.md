# Maya

[![ci](https://github.com/darkwarrior2005/Maya/actions/workflows/ci.yml/badge.svg)](https://github.com/darkwarrior2005/Maya/actions/workflows/ci.yml)

**Version 1.1.0.** `CHANGELOG.md` says what changed.

Maya runs several AI coding assistants on one project at the same time, under
one agent in charge. You give it a job in plain words. It splits the job up,
hands the pieces to different assistants, keeps each one on its own git branch,
and merges the work itself when it is happy with it. When something is
genuinely ambiguous, it asks you rather than guessing.

You watch it in a terminal or in a browser. They are two windows onto the same
session, live, and you can type into either one.

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

Maya does not talk to any AI company itself. It drives the coding tools you
already have installed and signed in to — Claude Code, GitHub Copilot CLI,
Google Antigravity, OpenAI Codex — so the work happens on your own accounts,
under your own limits, with your own credentials that Maya never sees.

---

## Contents

1. [What you need](#what-you-need)
2. [Installing](#installing)
3. [Signing in to the assistants](#signing-in-to-the-assistants)
4. [Your first session](#your-first-session)
5. [The two windows](#the-two-windows)
6. [Every command](#every-command)
7. [Choosing who does the work](#choosing-who-does-the-work)
8. [What it can and cannot change](#what-it-can-and-cannot-change)
9. [When Maya asks you something](#when-maya-asks-you-something)
10. [What it costs, and keeping that in hand](#what-it-costs-and-keeping-that-in-hand)
11. [Where Maya keeps things](#where-maya-keeps-things)
12. [When something goes wrong](#when-something-goes-wrong)
13. [Uninstalling](#uninstalling)
14. [For developers](#for-developers)
15. [Where this has been run](#where-this-has-been-run)

---

## What you need

### On your computer

| | Why | How to check |
| --- | --- | --- |
| **Node 20 or newer** | Maya is a Node program. Built and tested on 25. | `node --version` |
| **git** | Branches and worktrees are the whole design. Maya commits on your behalf. | `git --version` |
| **pnpm** | Only needed to install Maya, not to run it. | `pnpm --version` |

If `pnpm` is missing, install it without needing an administrator:

```bash
npm install -g pnpm --prefix "$HOME/.local"
```

Node 25 removed `corepack`, which used to supply pnpm automatically, so on a
current Node you install it yourself. On Windows, plain `npm install -g pnpm`
works.

### Git needs to know who you are

Maya makes commits for you, and git refuses to commit for someone with no name.
On a machine you have just set up, this is the single most common reason a
first run fails:

```bash
git config --global user.name "Your Name"
```

```bash
git config --global user.email "you@example.com"
```

`maya doctor` checks this and tells you if it is missing.

### At least one AI coding assistant

Maya drives tools you install separately. You need **at least one**; it works
with whatever is there and ignores the rest.

| Assistant | How you get it | Notes |
| --- | --- | --- |
| **Claude Code** | From Anthropic | Runs inside Maya rather than as a separate process, so it reports the most detail. |
| **GitHub Copilot CLI** | `npm i -g @github/copilot` | Each run costs one premium request, whatever the outcome. |
| **Google Antigravity** | antigravity.google/cli (not npm) | Thorough and slow. Cannot show a permission prompt when driven by a program, so it needs to be told in advance which commands it may run — see [running commands](#letting-a-worker-run-commands). |
| **OpenAI Codex** | `npm install -g @openai/codex` | Sandboxed by design. Refuses to work outside a git repository. |

### An account with money or quota on it

Every piece of work is a real call to a real assistant on your own account.
Maya spends nothing by itself and holds no keys, but **a session costs what
those tools cost**. See [what it costs](#what-it-costs-and-keeping-that-in-hand).

### A git repository to work on

Maya works on a project, not on loose files. It can create one for you —
`maya init` makes the folder and the repository if they are not there.

---

## Installing

### Linux and macOS

```bash
git clone https://github.com/darkwarrior2005/Maya.git
```

```bash
cd Maya && ./install.sh
```

This puts `maya` and `maya-mcp` in `~/.local/bin` and adds that folder to your
PATH if it is not already there. Open a new terminal afterwards, or:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Choices you can make:

```bash
./install.sh --prefix /usr/local   # install somewhere else (may need sudo)
```

```bash
./install.sh --no-path             # install, but leave my shell profile alone
```

### Windows

```powershell
git clone https://github.com/darkwarrior2005/Maya.git
```

```powershell
cd Maya; .\install.ps1
```

This puts `maya.cmd` and `maya-mcp.cmd` in
`%LOCALAPPDATA%\Programs\maya\bin` and adds that folder to your **user** PATH.
Open a new terminal afterwards. Nothing needs an administrator.

If PowerShell refuses to run the script:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Choices you can make:

```powershell
.\install.ps1 -NoPath                 # install, but leave PATH alone
```

```powershell
.\install.ps1 -Prefix D:\tools\maya   # install somewhere else
```

### Did it work?

```bash
maya --version
```

The installer runs that check itself as its last step, so if it printed a
version you are finished. Installing takes a few minutes, most of it
downloading dependencies.

### Keeping the clone

Do not delete the folder you cloned. The installed `maya` is a link into it, so
removing the clone removes Maya. To update later:

```bash
git pull && ./install.sh
```

---

## Signing in to the assistants

Each tool signs in once per machine, with its own command. Maya never sees,
stores or forwards any of these credentials.

```bash
claude login       # Claude Code
```

```bash
copilot login      # GitHub Copilot CLI
```

```bash
agy login          # Google Antigravity — opens a browser
```

```bash
codex login        # OpenAI Codex
```

Then ask Maya what it can see:

```bash
maya doctor -d .
```

It lists every tool, whether it is installed, whether it looks signed in, and
**which exact program it will run** — which matters more than it sounds. If you
have VS Code installed, `copilot` on your PATH may be a small stand-in shipped
with the editor rather than the real CLI, and doctor says so.

> Doctor reports a login as "not verified". That is honest rather than vague:
> a stored session looks perfectly healthy until it is used, and the only way
> to know is to spend a real request. `maya agents --live` is the command that
> actually finds out.

---

## Your first session

**1. Prepare a project.** This creates the folder if it does not exist, sets up
a git repository if there is not one, and adds Maya's own state folder:

```bash
maya init ~/my-project
```

**2. Check everything is ready:**

```bash
maya doctor -d ~/my-project
```

**3. Give it something small to begin with.** One assistant, one branch, no
splitting up — the simplest thing that works:

```bash
maya run "add a README explaining what this project is" -d ~/my-project
```

**4. Then try a real session**, where the Operator splits the job and several
assistants work at once:

```bash
maya start --tui "add a CSV importer with tests" -d ~/my-project
```

`--tui` gives you the pane view. Leave it off and you get a plain scrolling log
instead, which is better for recording or piping somewhere.

**5. Or watch it in a browser:**

```bash
maya web -d ~/my-project
```

### What actually happens

1. The Operator reads your request and decides whether it is one job or several.
2. Each piece goes to one worker, on its own branch named
   `maya/<task>/<worker>`, in its own private copy of the repository.
3. Workers do the work. Everything they say and every tool they use streams
   into both windows as it happens.
4. When a worker finishes, the Operator reviews the result and merges it —
   one branch at a time, never two at once.
5. A merge it cannot make cleanly becomes a question for you.
6. Work that failed, stalled, or came back empty is **never merged**.

### Asking it to plan first

If you want to see the split before anything runs:

```bash
maya start --plan "rewrite the importer and document it" -d ~/my-project
```

Maya proposes a breakdown and waits. You can accept it, tell it to do the whole
thing as one job, or type what you want instead.

---

## The two windows

### The terminal panes

`maya start --tui` or `maya attach` gives you the Operator in the main pane and
each worker in a pane below.

| Key or command | What it does |
| --- | --- |
| Type and press Enter | Sends a message into the session chat |
| `/localhost` | Opens the web window on the same live session |
| `/quit` | Leaves the view. The session keeps running |
| Ctrl-C | Same as `/quit` |

Worker panes are read-only. There is no program behind them waiting for your
keystrokes — the assistants are driven through a structured conversation, not a
terminal — so anything you want to say goes into the chat, where the Operator
reads it.

### The browser

`maya web` opens it for you. You get:

- **Git tree** — every branch and commit as it happens, so you can see work
  appear on a branch and then land on the main one.
- **Repository browser** — the project's files, updating live as agents change
  them.
- **Chat** — the whole conversation: the Operator assigning work, workers
  reporting, questions, merges.
- **Agents To Do** — what is queued, running, blocked, merged.
- **Direct messages** — a separate panel for anything an assistant wants to
  tell *you* rather than the Operator.
- **Usage** — tokens and cost per assistant and per model, for this session.
- **Agents page** — a scorecard for each assistant, at `#/arena`.

Both windows show the same session. Close either one and the work carries on;
reopen it and it catches up on what it missed.

---

## Every command

| Command | What it is for |
| --- | --- |
| `maya init <dir>` | Prepare a project. Creates the folder and repository if needed. |
| `maya doctor -d <dir>` | What is installed, signed in, and running — and which binary each tool resolves to. |
| `maya run "<task>" -d <dir>` | One assistant, one branch, no Operator. Good for a small job or a first try. |
| `maya run "<task>" -d <dir> --hold` | The same, but leaves the work on its branch instead of merging. |
| `maya start "<task>" -d <dir>` | A full session: Operator, several workers, merges. Scrolling log. |
| `maya start --tui "<task>" -d <dir>` | The same session in the pane view. |
| `maya start --plan "<request>" -d <dir>` | Propose a breakdown and wait for you to agree. |
| `maya start -y "<task>" -d <dir>` | Never stop to ask about a conflict; hold the branch instead. |
| `maya attach -d <dir>` | Open panes onto a session that is already running. |
| `maya web -d <dir>` | Open the web window. Add `--no-open` to not launch a browser. |
| `maya agents -d <dir>` | Score each assistant from what is already known. Costs nothing. |
| `maya agents -d <dir> --live` | Score them by giving each a real task. **Spends money.** |

Every command takes `-d <dir>` for the project; without it they use the current
folder.

### What `maya agents` is for

Maya measures the tools it drives instead of taking anyone's word for them. The
plain version costs nothing. `--live` gives each assistant three small real
tasks in a throwaway folder and watches: can it edit a file with the permission
Maya grants by default, does it leave things alone when told to, how long did it
take, did it report what it spent.

Results appear on the Agents page in the browser, one card per assistant.

A measurement that could not be taken says **not measured** rather than showing
a number. An early version scored a tool whose login had expired as the fastest
of the three, because failing took it 1.5 seconds.

---

## Choosing who does the work

Open `.maya/config.json` inside your project. It is plain JSON and Maya
re-reads it on the next run.

```json
{
  "version": 1,
  "operator": {
    "id": "operator",
    "tool": "claude-code",
    "displayName": "Operator",
    "stallTimeoutSec": 60,
    "enabled": true
  },
  "workers": [
    { "id": "worker-claude", "tool": "claude-code", "displayName": "Worker (Claude Code)", "stallTimeoutSec": 60, "enabled": true },
    { "id": "worker-copilot", "tool": "copilot-cli", "displayName": "Worker (Copilot CLI)", "stallTimeoutSec": 60, "enabled": false },
    { "id": "worker-antigravity", "tool": "antigravity-cli", "displayName": "Worker (Antigravity CLI)", "stallTimeoutSec": 60, "enabled": false },
    { "id": "worker-codex", "tool": "codex-cli", "displayName": "Worker (Codex CLI)", "stallTimeoutSec": 60, "enabled": false }
  ]
}
```

- **`enabled`** decides who takes part. Only Claude Code is on to begin with.
  Turn on the ones you have signed in to.
- **`tool`** is which assistant that worker drives.
- **`model`** names a specific model for that worker, if you want one.
- **`stallTimeoutSec`** is how long a worker may go silent before Maya decides
  it is stuck, kills it, and says so. The default is 60 seconds.
- **`allowedTools`** and **`deniedTools`** grant that worker more than the
  default, such as permission to run a particular command. The patterns differ
  per assistant — see [letting a worker run commands](#letting-a-worker-run-commands).
- **`maxTurns`**, **`maxBudgetUsd`** and **`maxTokens`** cap a single run,
  where the assistant supports it.

More workers means more things happening at once — and more money spent at
once. Two or three is usually plenty.

The Operator is also an assistant. It is the one that splits your request,
writes the summaries, and answers workers' questions, so give it the most
capable tool you have.

---

## What it can and cannot change

Maya never passes a "skip all permission checks" flag to anything. Every
assistant runs with permission to edit files in the project and nothing more:

| Assistant | What Maya grants |
| --- | --- |
| Claude Code | `acceptEdits` — edit files, no shell free rein |
| GitHub Copilot CLI | `write` |
| Google Antigravity | `--mode accept-edits` |
| OpenAI Codex | `workspace-write` sandbox — inside the project only |

If you want a worker to do more than that, you say so per worker in
`.maya/config.json`. The decision is yours and it is written down, rather than
being the default nobody noticed.

Two consequences worth knowing:

- **Shell commands are refused unless you grant them.** An assistant that
  wants to run a command will be denied, because granting that is not the
  default. See below for how to allow specific ones.
- **Work is isolated until it is merged.** Each worker edits its own private
  copy of the repository, so a worker that goes wrong cannot damage your
  working files. The Operator is the only thing that merges.

### Letting a worker run commands

Plenty of real work needs a command — running the tests, checking `git status`.
You allow specific ones per worker, by naming them in `allowedTools` on that
worker in `.maya/config.json`:

```json
{
  "id": "worker-antigravity",
  "tool": "antigravity-cli",
  "enabled": true,
  "allowedTools": ["command(npm test)", "command(git status)"]
}
```

Maya passes those to the tool for that one run and never writes them into the
tool's own settings. You can also list `deniedTools` the same way.

The patterns are the tool's own, and they differ between tools, which matters
because a pattern the tool does not understand grants **nothing**:

| Tool | Looks like | Notes |
| --- | --- | --- |
| **Antigravity** | `command(npm test)`, `command(*)`, `mcp(server/tool)`, `read_file(src/**)` | The target is a command line, not a tool name. `command(run_command)` grants nothing. |
| **Copilot** | `write`, `write(src/**)`, `shell(git:*)`, `mcp(server)` | A different grammar entirely. |
| **Codex** | — | Takes a sandbox policy rather than a list, and refuses a list outright instead of ignoring it. The policy is `workspace-write` and is not settable per worker in this version. |
| **Claude Code** | — | Uses its own permission mode, `acceptEdits`. Not settable per worker in this version. |

Maya checks these before it starts a run and refuses a pattern it knows the
tool will not understand, naming the likely mistake, rather than letting you
pay for a run that was never allowed to do the work.

> There is a limit worth knowing: Antigravity has a few tools whose approval
> cannot be granted this way at all — the ones whose whole purpose is to ask a
> person something. If one of those is needed, the run is denied whatever you
> put in `allowedTools`, and Maya tells you which tool it was.

---

## When Maya asks you something

**A merge it cannot make cleanly.** You get a question with options — keep the
branch for review, or abandon it — and a box to type your own answer. It
appears in whichever window you are looking at, and you can answer from either.
Nothing is merged while it waits.

**A worker needs a fact only you have.** Which of two files is the live one, how
a name should be spelled. That arrives in the direct-messages panel rather than
being buried in the Operator's transcript.

**A worker stopped without doing anything.** If a worker reports success but
changed nothing and asked nobody, Maya says so and shows you its last words.
That usually means it hit something it could not decide, or was refused a
permission it needed. A run like that is never treated as done.

---

## What it costs, and keeping that in hand

Every run is a real request on your own account. Rough figures measured on
one-line tasks:

- A small Claude Code task: about **$0.13–$0.15**.
- Copilot: **one premium request per run**, whether it worked or not.
- Antigravity and Codex: counted against whatever plan you are on. On a
  subscription login, Codex reports tokens but no cash figure.
- `maya agents --live` runs **three tasks per enabled assistant**.

Ways to keep it in hand:

- Start with `maya run`, which uses one assistant, before `maya start`.
- Turn off workers you are not using in `.maya/config.json`.
- Watch the usage panel in the browser as a session goes.
- Every run is bounded three ways — silence, total time, and tokens — so a
  stuck or looping assistant is stopped rather than left spending.

Maya has no spending cap of its own. The limits are the ones on your accounts.

---

## Where Maya keeps things

Everything for a project lives in one folder inside it:

```
your-project/
  .maya/
    config.json        which assistants, which models, which permissions
    state.db           the full history of the session
    daemon.lock        which process is serving this project, on which port
    agents/<id>/       what each assistant was told and said, as .md and .html
    logs/<id>.ndjson   raw output, for working out why something stalled
```

`.maya/` is kept out of git in a way that does not touch your own `.gitignore`,
so it never shows up in your commits or your diffs.

Delete a project and its Maya state goes with it. Nothing is stored anywhere
else on your machine.

---

## When something goes wrong

| What you see | What it means | What to do |
| --- | --- | --- |
| `maya: command not found` | The install folder is not on your PATH yet. | Open a new terminal, or `export PATH="$HOME/.local/bin:$PATH"`. |
| `git has no user.name/user.email` | Git cannot commit for an anonymous person. | Set both with `git config --global`, as above. |
| `<dir> does not exist` | You pointed at a folder that is not there. | `maya init <dir>` creates it. |
| `pnpm is not on PATH` while installing | Node 25 dropped corepack. | `npm install -g pnpm --prefix "$HOME/.local"`, then run the installer again. |
| `Permission denied` running `./install.sh` | The file lost its executable bit somewhere. | `chmod +x install.sh`. |
| Doctor warns about a **shim** | A stand-in from another program is shadowing the real CLI on your PATH. | Either accept it or put the real one earlier on your PATH. |
| A worker is marked **stalled** | It went quiet for longer than its timeout. | Look in `.maya/logs/<worker>.ndjson` for the last thing it did. Its work is not merged. |
| A worker "changed nothing and asked nobody" | It stopped without doing the job. | Read its last words in the message. Usually an ambiguous task or a refused permission. |
| Antigravity "was denied RunCommand" | It needed to run a shell command, which is not granted by default. | Add `"allowedTools": ["command(<the command>)"]` to that worker — see [letting a worker run commands](#letting-a-worker-run-commands). |
| "is not an Antigravity permission kind" | A pattern in `allowedTools` is not one that tool understands. | The message names the likely fix. Antigravity wants `command(npm test)`; Copilot's `write` means nothing to it. |
| The browser window is empty | The daemon is not running for that project. | `maya web -d <dir>` starts one. `maya doctor` says whether one is already up. |
| A login that worked yesterday fails | Stored sessions expire. | Sign in again with that tool's own `login` command. |

If a run ends badly, two places hold the evidence: `.maya/logs/<worker>.ndjson`
is the raw output of the tool itself, and `.maya/agents/<worker>/latest.md` is
what Maya understood from it.

---

## Uninstalling

Delete the installed links and the clone:

```bash
rm ~/.local/bin/maya ~/.local/bin/maya-mcp && rm -rf /path/to/Maya
```

```powershell
Remove-Item "$env:LOCALAPPDATA\Programs\maya" -Recurse
```

The installer leaves one line in your shell profile on Linux and macOS, marked
`# added by Maya's install.sh`; on Windows it adds a folder to your user PATH.
Remove either by hand if you want it gone.

Each project keeps its own `.maya/` folder. Delete those to remove the history
of those sessions.

---

## For developers

Maya is a pnpm workspace. The installer runs these for you; this is what it
runs.

```bash
pnpm install && pnpm build
```

```bash
pnpm test          # 295 tests
```

```bash
pnpm lint
```

```bash
pnpm package       # bundles a self-contained maya into dist/maya
```

Checks that cannot be unit tests drive real terminals, a real daemon and the
real packaged bundle:

```bash
node tools/verify/mcp.mjs          # the MCP server over stdio, against a daemon
```

```bash
node tools/verify/agents.mjs       # the agent probes, against misbehaving stand-ins
```

```bash
node tools/verify/packaged.mjs     # the bundle, driven from an unrelated folder
```

```bash
node tools/verify/panes.mjs        # 23 checks in a real pseudoconsole
```

```bash
node tools/verify/conflict.mjs     # a merge question asked and answered in a pane
```

```bash
node tools/verify/planning.mjs     # the Operator splitting a request
```

The pseudoconsole harnesses need the optional `node-pty`, which has prebuilt
binaries for Windows and macOS only. On Linux it compiles where a C++ toolchain
exists and is simply absent where one does not — Maya builds and runs either
way. Without it those harnesses print `SKIPPED` and exit 0.

For hot reload on the web interface, run a daemon with `maya web`, then:

```bash
MAYA_PORT=<its port> pnpm --filter @maya/web-client dev
```

### Driving Maya from another agent

`maya-mcp` is an MCP server over stdio, installed next to `maya`. Point any MCP
client at it with `MAYA_PROJECT` set to the project:

```json
{ "command": "maya-mcp", "env": { "MAYA_PROJECT": "/path/to/project" } }
```

It can read the session, post to the chat, message you directly, and answer the
Operator's merge questions. It deliberately cannot queue work — the Operator
decides what runs.

### Adding another assistant

Write one adapter and name it in `.maya/config.json`;
`docs/adapter-plugin-example.mjs` is a working one. No orchestrator code
branches on which tool an agent is.

### How it fits together

One daemon per project owns the event log and serves both windows on one port.
The terminal and the browser are both WebSocket clients of it, and both replay
from their last-seen event on connect, so a dropped connection cannot leave a
window quietly stale.

| Package | Owns |
| --- | --- |
| `packages/shared-types` | The event and payload types. No logic. |
| `packages/core` | Adapters, orchestrator, git, the event log, the daemon, agent probes. |
| `packages/cli` | The commands and the pane view. |
| `packages/web-client` | React + Vite: git tree, file browser, chat, Agents page. |
| `packages/mcp-server` | Maya as an MCP server. |

### Further reading

- **`docs/PLAN.md`** — the target, what is built, what is deferred.
- **`docs/FINDINGS.md`** — every trap that cost hours and what it actually was.
  Read it before touching an adapter, the terminal code, or a dependency
  version.
- **`docs/adr/`** — decisions that went against the original plan, with the
  reasoning.
- **`CLAUDE.md`** — the seventeen invariants. Breaking one is a correctness bug,
  not a style question.
- **`bugfixy.md`** — every issue found while reviewing the build, and what the
  fix turned out to be, which was often not what was predicted.

---

## Where this has been run

CI runs on every push, on three machines:

- **Ubuntu** — install, build, lint, the full suite, and the MCP, agent-probe,
  packaged-bundle and pane harnesses.
- **Windows** — the same.
- **A container with nothing in it but Node and git** — the whole installer end
  to end, with no compiler, because that is what the requirements above
  actually promise.

All four assistants have been driven against their real CLIs, not stubs.

What CI cannot cover is your particular machine. If an install or a login
breaks on it, that is worth an issue.
