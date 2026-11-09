# Findings

Things that cost real time to discover. Each one is a trap that looks like
something else when you hit it. Read this before changing an adapter, the
terminal code, or a dependency version.

## Wrapped CLIs

**Exit codes are not trustworthy.** Copilot CLI exits 0 and reports a normal
`result` record even when every tool call was denied and nothing was done.
Treating that as success merged a branch where the agent had done nothing. The
adapter therefore takes the tool's own completion record over the exit code, and
a recorded fatal error overrides both: `ok = reportedOk && fatalError === undefined`.

**Copilot permissions are patterns, not tool names.** The form is
`kind(argument)`: `write`, `write(path)`, `shell(git:*)`. Passing an internal
tool name such as `apply_patch` silently grants nothing and every call is
denied. Default is `["write"]` — edits only, no shell. Copilot also
auto-approves tools it classifies as safe, so a read-only `git status` can
succeed with no shell permission at all; that is Copilot's policy and Maya does
not override it. Each run costs one premium request. On a machine with VS Code
installed, a shim can shadow the real `copilot` binary on PATH.

**Antigravity streams deltas.** `--output-format stream-json --mode accept-edits`.
`text_delta` fragments must be joined per `step_index` and emitted only when the
step reaches `state: "DONE"`; a successful step carries no status field at all.
The failure shape is unconfirmed — no failing sample was available — so success
is inferred from reaching `DONE` without an error.

**Claude Code needs git-bash on Windows.** The SDK fails with a bare "exited
with code 1" unless `CLAUDE_CODE_GIT_BASH_PATH` is set; the real explanation is
on stderr, which an adapter that discards stderr will never show you.
`findGitBash()` resolves `git.exe` and walks up to four ancestors looking for
`bin/bash.exe` or `usr/bin/bash.exe`, because MSYS git lives in
`...\Git\ucrt64\bin` and the naive parent is wrong.

**A failed Claude Code result can say `subtype: "success"`** with `is_error:
true`. Prefer `message.result` over `subtype` when building the error.

**Pipes, not PTYs.** A console screen buffer hard-wraps long lines, and these
tools emit multi-kilobyte JSON. Under a PTY a Copilot run once "succeeded" and
merged a correct file while the chat log captured no text, no tool calls and no
usage at all — corruption that looks like success. `cols: 4096` was not enough.
Pipe is the default and should stay the default.

**`node-pty.kill()` on a child that already exited** forks a helper to enumerate
console processes, which fails with "AttachConsole failed" and prints a stack
trace over Maya's output. Skip the kill once the child is gone.

**node-pty does not do PATH or PATHEXT lookup.** It spawns the binary directly,
so `agy` fails with "File not found" where a shell would have found `agy.cmd`.
Hence `resolveExecutable()`.

**Never default to the bypass flags.** Not `bypassPermissions` (Claude), not
`--yolo` / `--allow-all-tools` (Copilot), not `--dangerously-skip-permissions`
(Antigravity). The defaults are `acceptEdits`, `write`, and `--mode accept-edits`.

## Terminals

**Under ConPTY — every modern Windows terminal — `process.stdout.columns` and
`.rows` are frozen** at the size the console had when the process started, and
no `resize` event is ever emitted. Verified directly: a child kept reporting
110x30 after its pseudoconsole was resized to 70x18.

**`CSI 18 t` ("report text area size") is swallowed by ConPTY** without an
answer. **`CSI 6n` (cursor position) is answered correctly**, before and after a
resize. So Maya measures the terminal: save cursor, move to `[999;999H`, ask
`[6n`, restore cursor — and takes the answer over Node's values. The reply
arrives on stdin like a keystroke and must be filtered out of user input,
including when a read splits it in two.

**Agent output may contain escape sequences.** They repaint parts of the screen
Maya did not draw, and they count toward a line's length while occupying no
columns, which silently mis-sizes every pane on the row. Stripped in the layout
itself, which is the thing that promises length equals visible width.

**A resize must repaint from a cleared screen.** The console reflows the old
lines and a shorter frame does not cover the rows the old one occupied.

**Legacy `conhost` often runs a non-UTF-8 code page**, where box-drawing
characters arrive as mojibake. `pickCharset()` draws ASCII on an unannounced
Windows console; `MAYA_TUI_CHARSET=unicode|ascii` overrides.

## The daemon and the web interface

**Binding to 127.0.0.1 is not access control.** The browser on that same
machine is the threat. WebSockets are exempt from the same-origin policy, so
any page the user has open can connect to a localhost daemon and read
everything; and a cross-origin POST with a non-preflighted content type still
*arrives*, CORS only hides the response from the sender. Measured against a
running daemon before the check existed: a page served from another port read
the whole event log, secret channel included, and posted a message that landed
in it. The daemon now checks `Origin` on both paths. A request with no Origin
is allowed, because that is the CLI or a script, which can read
`.maya/state.db` directly anyway.

**A row written to the event store from outside the daemon reaches nobody, and
is skipped permanently.** The daemon's in-process emitter is what pushes to
connected views, and every view resumes from the highest id *it* has rendered —
so an out-of-band insert is passed over on the next reconnect rather than
caught up. Observed with an open browser: the row landed in SQLite and never
appeared. Anything outside the daemon posts to `/api/message` instead.

**Vite does not typecheck.** `vite build` happily ships a type error, so
`@maya/web-client`'s build runs `tsc --noEmit` first. It is not a composite
project: tsc only checks there, and Vite emits.

**The web client must not import `@maya/core`.** Core pulls better-sqlite3 and
simple-git. Types that cross the wire — `FileNode`, `RepoTree`, `SessionInfo`,
`ServerMessage` — live in `@maya/shared-types`, which is types only.

**`git ls-files --cached --others --exclude-standard -z` is the file tree.**
It is "tracked, plus untracked that is not ignored" in one call, so .gitignore
is honoured without reimplementing it. `-z` matters: a path may contain
anything but NUL, and git quotes and escapes paths otherwise.

**`git log --graph` implies `--topo-order`.** Matching it means passing
`--topo-order` explicitly; the default order interleaves branches by date and
the lanes come out unreadable.

**The state dir makes the tree look dirty** unless `excludeStateDirFromGit` has
run. `maya init` does it; a test that calls only `paths.ensureDirs()` will see
`clean: false` and the reason is `.maya/` itself.

**An agent can only use a channel it was told about.** The secret channel is
a marker (`@user` at the start of a line) in the agent's own output, because a
wrapped CLI has no other way to say anything. `withSecretChannel()` appends the
briefing to every instruction; without it the feature is dead code.

**Render a pending question from events, not from the resolver.** The resolver
object lives in whichever process owns the Operator. A pane attached from
another process has the events but not the object, so deriving the prompt from
`conflict_prompt` minus a matching `conflict_resolved` is what lets every view
show it — and posting the answer is what lets every view answer it.

**A plugin's adapter id must match the config's.** Worker profiles resolve
adapters by that name, so an adapter that registers itself as something else
would be loaded and then never found. The loader refuses the mismatch and says
both names.

**The Agent SDK does not export its `package.json`.** Anything that locates
packages by resolving `<name>/package.json` fails on it; walk up from what
`require.resolve(name)` returns instead. This bit the packaging harness.

**Three things cannot be bundled**: better-sqlite3 and node-pty load native
binaries, and the Agent SDK resolves files relative to its own package
directory. `tools/package.mjs` keeps them external and names them in the
generated manifest.

**An ESM bundle needs `require`, `__filename` and `__dirname` shimmed.** `ws`
and simple-git reach for them; esbuild's `banner` supplies them.

## Tooling and versions

**pnpm 12 ignores `pnpm.onlyBuiltDependencies`** in `package.json` *and* in
`pnpm-workspace.yaml`. The setting is `allowBuilds`, at the top level of
`pnpm-workspace.yaml`, and it must be a **mapping**, not a list.

**The Agent SDK ships a ~160MB bundled Claude Code binary per platform.** Maya
drives the `claude` a machine already has, so every platform variant is listed
under `ignoredOptionalDependencies`. Skipping it took install from
never-finishing to about a minute.

**Pin the SDK to the installed CLI's generation.** SDK 0.1.77 against CLI 2.1.319
fails with `400 tool_use ids must be unique` — reproducible with the bare SDK
outside Maya, so do not go looking in Maya's code. `^0.3.319` matches.

**better-sqlite3 `^13`** has prebuilds for Node 25 (ABI 141). Older majors try
to compile and need VS Build Tools.

**node-pty is an optional dependency.** It ships prebuilds for Windows and macOS
only — none for Linux — so as a hard requirement it would force a C++ toolchain
on every Linux install. Nothing Maya does by default needs it; only the `pty`
transport and the verification harnesses in `tools/verify/` do.

**vitest needs raised timeouts.** The git-heavy tests run a dozen git
invocations each; the 5s default is not enough on Windows. `vitest.config.ts`
sets 30s.

**Windows holds file handles slightly longer than the process does.** Test
teardown uses `safeRemove` with retries, and cleanup is registered at setup time
so a failing assertion still releases handles. Context snapshots write to a temp
file and rename, retrying on EBUSY/EPERM/EACCES; a failed snapshot logs and
skips rather than crashing the daemon.

**`tsc -b` and a moved checkout.** Copying the tree with `robocopy` brings stale
`.tsbuildinfo` files, so `tsc -b` decides everything is up to date and emits
nothing while `dist/` is missing. Delete them after any move.

**Git prints CRLF warnings** on commit here. Expected on Windows; not a problem.
