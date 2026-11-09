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
