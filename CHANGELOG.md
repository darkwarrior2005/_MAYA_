# Changelog

## Unreleased

- **A cast page**, at `#/cast` in the web interface: Maya and the four
  assistants as animated figures you pick from, each with what it is good and
  bad at. The roster at `#/arena` is for comparing four cards side by side;
  this is for meeting them one at a time. Both read the same report, so they
  cannot disagree about what was measured.
- **Maya has a card of its own**, which it did not before. Its strengths are
  the invariants the project is prepared to defend. Its weaknesses are *not*
  written by hand — they are read from the platform notes that are still
  open, so the card cannot quietly stop admitting something the codebase
  still records: close a note and it leaves the card, add one and it appears.
  It deliberately has no stat bars, because every figure on an assistant's
  card came from running that assistant and there is no equivalent run of the
  host to put beside them.
- Every animation sits behind `prefers-reduced-motion`, since a page of
  bobbing figures is what someone turns that setting on to stop.
- **Fixed: `pnpm package` uninstalled the `maya` on your PATH.** The installers
  run `npm install` inside `dist/maya` and the installed command links into
  it, but the packager deleted that whole directory on every run — so on a
  machine where Maya was both installed and being worked on, any rebuild left
  `maya` failing with `ERR_MODULE_NOT_FOUND` about a package nobody had
  mentioned. The clean now keeps `node_modules`, the packager says whether the
  runtime dependencies are present, and `tools/verify/packaged.mjs` fails if a
  rebuild ever removes them again.

## 1.1.0 — 13 Nov 2026

One fix, to the last real limitation left after build 1.

- **An Antigravity worker can be allowed to run commands.** Headless `agy`
  cannot show a permission prompt, so anything needing one was auto-denied —
  and the run still reported success with an empty answer, which read as an
  agent choosing to do nothing rather than one that was never allowed. A
  worker's `allowedTools` are now passed as session-only `--settings`
  permission rules, so `"allowedTools": ["command(npm test)"]` lets that
  worker run that command and nothing else. The tool's own `settings.json` is
  never written to, and with nothing granted the default is unchanged.
  Verified against the real tool.
- A pattern the tool would not understand is **refused before the run**,
  naming the likely mistake, because such a pattern grants nothing silently
  and the blame lands on the agent. Antigravity wants `command(npm test)`;
  Copilot's `write(src/**)` means nothing to it, and the tests check each
  validator rejects the other's grammar.

## Build 1 — 1.0.0

The first complete build. Everything in the original plan is implemented, all
four assistants have been driven against their real CLIs rather than stubs, and
the whole thing has been installed and used on both Windows and Linux.

### What it does

- **An Operator that thinks.** It reads a request, decides whether it is one
  job or several, hands each piece to a worker, reviews what comes back, writes
  the summary, and merges. It also answers workers' questions, so the person is
  not interrupted for things the session already knows.
- **Four assistants supported** — Claude Code, GitHub Copilot CLI, Google
  Antigravity and OpenAI Codex — each behind one adapter, with no orchestrator
  code branching on which tool an agent is. A project can add another by naming
  a module in its config.
- **Two live windows on one session.** A terminal pane view and a web
  interface, both reading the same event log, both able to answer the same
  questions. Either can be closed and reopened without losing anything.
- **Work isolated until it is merged.** Each worker runs in its own git
  worktree on its own branch. The Operator is the only thing that merges, one
  branch at a time, and never merges work that failed, stalled or came back
  empty.
- **Two ways for an agent to reach out.** `@operator` for anything about the
  task, `@user` for the things only a person can settle.
- **Agent scorecards.** `maya agents` measures the tools Maya drives rather
  than repeating their claims, and `--live` measures them by giving each a real
  task.
- **An MCP server**, so another agent can read a session, post to it, reach
  the person, and answer the Operator.

### What this build was shaped by

Most of the work after the features were built went into things that were
quietly wrong. Each of these is written up where it happened, in
`docs/FINDINGS.md` and `bugfixy.md`:

- **Nothing had been run on Linux.** CI now runs the suite on Ubuntu and
  Windows, and the installer in a container with no compiler. That last job
  found that `pnpm build` could not run at all on a machine without build
  tools: node-pty was called an optional dependency but was a compile-time one.
- **Measurements that flattered failure.** The agent probes scored a tool whose
  login had expired as the fastest of three, because failing was quick. A
  probe that cannot be taken now says so rather than showing a number.
- **Prompt wording decided whether a feature worked at all.** Given a task it
  could not do honestly, one model asked the Operator a question no Operator
  could answer, and another asked in prose where nothing was listening.
  Rewriting the briefing fixed the first. The second is why a worker that
  reports success, changes nothing and tells nobody is now reported rather
  than passed over.
- **A prompt containing `%PATH%` leaked the machine's PATH into it**, because
  on Windows an npm-installed tool is a batch shim and the command line goes
  through `cmd.exe`. Prompts no longer travel on a command line.
- **Two fixes that were wrong before they were right**, both passing their
  tests while wrong: a concurrency assertion that measured a race three
  different ways before being rewritten to measure nothing, and a token
  subtraction copied from one vendor's convention to another's, where the same
  field name means the opposite thing.

### Known limits

- Worker panes are read-only. There is no process behind them to take
  keystrokes; anything you want to say goes into the chat.
- No spending cap of Maya's own. The limits are the ones on your accounts.
- Antigravity's three ask-a-person tools cannot be approved by a permission
  rule — the tool says so itself — so a run needing one is refused whatever a
  worker was granted. Maya reports which.
- Linux has been tested in a container, not on a desktop distribution.
