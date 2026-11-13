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

**Antigravity's failure shapes, confirmed at last** (agy 1.5.6). They were
inferred from documentation for months, which is why `bugfixy.md` B3 said to
check them the next time it failed. Made to fail on purpose instead — a read
of a file that is not there, a shell command headless mode cannot approve, and
an invalid `--model` — these are what came back:

- **A failed tool step is `state: "ERROR"`**, a state value nothing in the
  parser had anticipated, and its error lives at `tool_info.error` as an
  **object**: `{ type: "TOOL_ERROR", message: "file does not exist" }`. Not a
  string, and not on the step itself, which is where the code looked first.
  It came out right by luck, because an object is truthy; passed through to a
  pane it rendered as `[object Object]`.
- **A failed tool does not fail the run.** `result.status` stayed `SUCCESS`
  while the agent read the error, explained it and stopped. That is correct of
  Antigravity and the parser was right to leave it alone: invariant 3 says a
  reported success is not success, which is not licence to invent a failure
  the tool never claimed.
- **A denied permission also leaves `status: "SUCCESS"`**, with an empty
  `response`. Asked to run a shell command under Maya's default
  `--mode accept-edits`, headless `agy` auto-denied it and called the run a
  success. The only structured trace is **`result.denied_actions`**:
  `[{ action: "command", display_name: "RunCommand" }]`, which Maya ignored
  entirely, leaving one line on stderr as the sole evidence — so the reader
  concludes the agent declined the work when in fact Maya never allowed it.
  Now reported as a non-fatal error naming what to allow, **and grantable**:
  see the next finding.

**`--settings` is how an Antigravity worker is allowed to do anything.** The
denial above made an Antigravity worker close to useless for real work —
anything needing a command was refused, and the refusal looked like a choice.
Its own stderr names the way out, and the flag that applies it per run is
`--settings`: "Settings for this session only, never saved: a JSON object of
settings.json keys". So a worker's `allowedTools` become
`--settings {"permissions":{"allow":["command(git status)"]}}`, granted for
one run, with the user's own `settings.json` untouched. Verified against the
real tool: granted `command(git status)`, it ran the command and reported the
branch name it could only have learned by running it.

The grammar is the tool's own, read out of the binary rather than guessed —
the kinds it writes with a wildcard are `command`, `mcp`, `read_file`,
`write_file`, `read_url`, `download_url`, `execute_url`, and the examples it
carries are `command(npm test)`, `command(git status)`, `command(*)`,
`mcp(chrome-devtools/*)`. **The `command` target is a command line, not a tool
name**: the tool is `run_command`, and `command(run_command)` grants nothing,
silently, which is exactly how an agent gets blamed for refusing work it was
never allowed to do. `describeBadAntigravityPermission` refuses a pattern
before the run for that reason, the same guard Copilot's permissions have, and
the two grammars are deliberately checked against each other in the tests
because a worker profile copied from one tool to the other would grant nothing
at all.

Two limits to keep in mind. `--settings` replaces the keys it names for that
session, so a worker granted `command(git status)` does not also inherit the
person's own allow-rules — it narrows rather than widens, which is the safe
direction but can surprise. And the binary carries a second message for a
class of tools where **"Settings allow-rules do not apply"** — the ones whose
purpose is to ask a person something. No allow-rule grants those; only
`--dangerously-skip-permissions` would, and invariant 5 says Maya does not
reach for it.
- **`result.error` is where a real failure explains itself**, next to
  `finished_reason`. Maya was discarding it and printing `run finished with
  status ERROR`. The text it threw away: `invalid model selection (--model
  "not-a-real-model"): model not recognized ... Available models: ...` — the
  difference between a reader who knows what to fix and one who does not.

**Antigravity's `cache_read_tokens` is NOT inside `input_tokens`, and this is
the trap.** Its `total_tokens` is `input + output` every time and never counts
the cache, which reads exactly like OpenAI's convention — where the cached
part *is* inside the input, and `codex-cli.ts` correctly subtracts it out. I
copied that reasoning here and was wrong. The third captured run refutes it:
**19,712 cached against 2,296 input.** A subset cannot exceed its set, so
Antigravity's `input_tokens` is already the fresh part and cached reads are
counted separately — the Anthropic convention. Two vendors, the same field
name, opposite meanings. Do not carry this fix between adapters, and do not
"correct" an adapter so its figures match a tool's own total without checking
which definition that total uses: Maya's `totalTokens()` counts cache reads
deliberately, so it reads higher than `agy`'s and that is a difference of
definition, not a bug. Two samples agreed with the wrong answer; the third
settled it.

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
(Antigravity), not `--dangerously-bypass-approvals-and-sandbox` / `--yolo` or
`--sandbox danger-full-access` (Codex). The defaults are `acceptEdits`,
`write`, `--mode accept-edits`, and `--sandbox workspace-write`.

**Codex grants permission with a sandbox, not a tool list, and `codex exec`
defaults to `read-only`.** So a Codex worker that is not given
`--sandbox workspace-write` cannot change one file, and the run looks like an
agent that decided not to do the task rather than one that was not allowed to.
The flip side is that a worker profile carrying Copilot's `allowedTools` means
nothing here: `codex-cli.ts` refuses it before the spawn rather than dropping
it, because silently ignoring a permission setting runs the agent with more
freedom than whoever wrote the profile thought they had granted. Note also
that `--full-auto` is gone, and `--approve-for-me` conflicts with `--sandbox`.

**Codex's `cached_input_tokens` is a subset of `input_tokens`, not an
addition.** Its own documented sample reports 24,448 cached of 24,763 input.
Maya sums `inputTokens + cacheReadTokens`, so reporting both whole bills a
cached prompt at nearly 50k instead of 24,763. The adapter subtracts the
cached part out of the fresh input, which makes the two add back to exactly
what Codex said. The same reasoning leaves `reasoning_output_tokens` inside
`output_tokens`.

**`exec`'s flags go before the `resume` subcommand.** `--json` and `--sandbox`
belong to `exec`; placed after `resume` they are read as that subcommand's
flags, which it does not have. And the prompt goes behind a `--`, because a
prompt is arbitrary text: one starting with a dash parses as a flag, and a
prompt of exactly `-` means "read the prompt from stdin", which hangs on a
stdin nobody will write to.

**Codex's event stream matched its documentation, and driving it still found
four things reading could not.** The adapter was written against OpenAI's
published JSONL sample with no `codex` installed. Checked later against
codex-cli 0.167.1, the documented shape held exactly:
`thread.started`/`turn.started`/`item.completed`/`turn.completed`, carrying
`thread_id` and the usage field names. `resume <id>` worked and the session
genuinely remembered its own previous answer. The only difference was an
extra `cache_write_input_tokens`, now read.

That is the good news, and it is the least interesting part. The first real
run found four faults in **Maya**, three of which had nothing to do with
Codex:

**`codex exec` reads stdin to EOF before it starts.** It prints "Reading
additional input from stdin..." and waits, because its documented behaviour is
to append piped stdin to the prompt. Given an inherited pipe that nobody
writes to and nobody closes, it waits forever — a seven-minute hang on a
one-word prompt, which a stall watchdog would eventually kill and report as a
stalled agent. Maya is safe by accident of a good default: the pipe transport
passes `stdio: ["ignore", …]`, which is an immediate EOF. A PTY would not be,
which is one more reason this adapter never asks for one.

**`where` lists an entry point Windows cannot run, first.** `npm i -g` installs
three: an extensionless shell script for Git Bash, a `.cmd`, and a `.ps1`.
`where` prints the exact-name match first, `CreateProcess` cannot execute it,
and the spawn fails with `ENOENT` naming a file that plainly exists. The
resolver preferred `.exe` and then fell through to the first line — which is
the shim it meant to avoid. It now picks by extension: `.exe`, then what
cmd.exe can run. Nothing had caught this because no adapter had ever resolved
to an npm shim: `agy` is `agy.exe` under AppData, `claude` is `claude.exe` and
runs in-process anyway. A comment in `subprocess-adapter.ts` asserting that
"`agy` resolves to agy.cmd on Windows, so this is the normal case" was simply
wrong, and had been wrong unchallenged.

**`shell: true` concatenates arguments without escaping them.** This is the
sharp one. Node refuses to spawn a `.cmd` directly (CVE-2024-27980) and the
obvious workaround is `shell: true` — but then arguments are joined, not
passed, so the first one containing a space arrives as several. Codex received
the first word of the task and rejected the second: `error: unexpected
argument 'with' found`. Node's own DEP0190 warns about this. cmd.exe is now
invoked directly with the command line built here, each token quoted and the
whole wrapped in one more pair because `/s` strips the outermost.

**That still left `%NAME%`, and it was worse than a mangled prompt.** cmd.exe
expands a percent variable *inside* a quoted argument, and no escape helps —
the one it offers works only inside a batch file. Measured through a real
round trip rather than assumed: a prompt reading `Explain what %PATH% means`
reached the agent with the machine's entire PATH spliced into it. The prompt
ruined, and the user's directory layout handed to a third-party tool that had
no business seeing it. The answer is to stop putting arbitrary text on a
command line at all. `codex exec` reads its prompt from stdin when given `-`,
so Maya writes it there and closes the pipe; a real run asked to echo
`%PATH%` back now returns it literally. `SubprocessSpawnSpec.stdin` is open to
any adapter whose tool can do the same, and leaving it unset keeps stdin at
`"ignore"` — the immediate EOF that stops `codex exec` hanging while it waits
to read.

**Codex refuses to work outside version control**, with "Not inside a trusted
directory and --skip-git-repo-check was not specified". The live probe
workspace was a bare temp directory, so Codex scored as *unable to edit a
file* — a verdict about the probe, not the tool, and the same dishonesty as
scoring an expired login as a permissions problem. The probe workspace is a
git repository now, which is what a worker actually gets, and
`classifyFailure` names this shape so the advice stops pointing at
permissions. Passing `--skip-git-repo-check` would have been the wrong fix:
the guard is sensible and real runs always have a worktree.

With all four fixed, Codex passes 9/9 live probes: wrote the file in 19.8s,
reported 46243 tokens, left the tree alone when told to. **The lesson is the
ratio.** The parser, the part that was guessed, was right. Everything that
broke was in the plumbing nobody thought was in question.

One more thing worth sitting with: `traits.ts` already listed "refuses to run
outside a git repository" as a known trait of Codex, in the same codebase as
a live probe that ran it in a bare temp directory. The fact was written down
and not acted on. A note is not a safeguard — if something is going to break
a run, it belongs in the code that sets the run up, not only in a list a
person reads.

**The wording of the channel briefing decides whether the channel is used at
all, and for one model it decides nothing.** The `@user` marker is how a
worker reaches the person, and whether a model reaches for it is a prompting
question, not a plumbing one — so it was tested the only way it can be: give
two live agents a task that cannot be done honestly (delete whichever of two
near-identical price lists is unused, in a repository that nowhere says which)
and watch.

Both refused to guess, which is the right behaviour, and neither reached the
person. Claude Code used **`@operator`**, twice, for a fact no Operator could
possibly hold — the briefing ended "prefer this to `@user`" and the qualifier
"for things it can settle" did not survive the reading. Codex used **no
marker at all**: it asked in prose, which goes nowhere, and the run was then
recorded as a clean success with the question sitting unread in its
transcript.

Rewriting both briefings fixed the first — choose by *who could know* rather
than by preference, show the literal `@user` line rather than describing it,
and say outright that an unmarked question is delivered to nobody. Claude Code
then asked the person, on the secret channel, on the identical task. Codex
still does not, with the same text.

Two things to take from that. **Prompt text is code with a slower test
cycle**: three sentences changed which channel a model chose, and no amount
of reading the text would have told you. And **a mechanism that needs a model
to opt in needs a backstop that does not.**

That backstop exists now, and designing it taught the sharper lesson. The
obvious signal was a question: changed nothing, reported ok, last text ends
in a question mark. Checked against the two transcripts actually captured, it
fails immediately — **Claude Code's refusal contains no question mark at
all.** It narrated being stuck and asked nothing. The detector would have
missed the case that motivated it, and would have looked fine in any test
written from imagination rather than from a recording.

What is true regardless of what the model emits is: **reported ok, committed
nothing, told nobody.** That worker neither did the work, nor failed, nor
asked. `worker_stopped_short` says so on the secret channel with the
worker's closing words, and `maya run` prints them. Note what did *not* need
changing: the Operator already marks a task with no commit `blocked` rather
than merged, so the state machine was right all along — the hole was that
nobody was told why. **Check what is already correct before building on top
of it**; the fix was a quarter the size it first looked.

**A smarter measurement of a race is still a measurement of a race.** The
parallelism test in `operator.test.ts` took three assertions to stop being
flaky, and the middle one is the instructive failure. First it timed two
120ms tasks against a 2000ms ceiling, which measured git — a worktree takes
seconds on Windows — and failed whenever the machine was busy. That was
replaced with a comparison of the two runs' recorded spans, and called
structural. It was not: it still needed the overlap to be large enough to
see, and it failed on a Windows CI runner because a worker's worktree is
created before its agent starts and *that* part is serialized. With a 120ms
stub, the first run can finish before the second begins while both were
dispatched concurrently, exactly as intended — a true claim, failing.

What finally worked has nothing to measure: neither stub run may finish until
both have begun, and the flag is set only when the last arrival finds someone
still waiting. It ships with a negative control — one worker, two tasks,
serial by invariant 14 — asserting the rendezvous reports false. An
assertion about concurrency that has never been watched failing is not
evidence of anything, and both earlier versions passed locally for weeks.

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

**ConPTY does not do grapheme clustering.** Measured by printing into a
pseudoconsole and asking where the cursor landed
(`tools/verify/column-width.mjs`): a regional-indicator flag advances 4
columns, a ZWJ family 8, and a combining accent 1 of its own. It does absorb a
variation selector, so U+26A0 is 1 column and U+26A0 U+FE0F is 2. Terminals
that cluster would draw those narrower, so `width.ts` matches ConPTY and
over-estimates elsewhere — **over-estimating leaves a gap at the end of a
line, under-estimating wraps it and scrolls the screen.**

**Width is columns, not characters.** Counting code points made
"done OK shipped ROCKET ok" 42 columns in a 40-column frame. And the wide set
is not a block: U+2713 check mark is narrow while U+2705 heavy check mark is
wide, so a blanket range over the symbol block is wrong in both directions.

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

**The Operator gave one worker several tasks at once.** Tasks were handed out
with `Promise.all` over a round-robin, so a worker with more tasks than
colleagues ran them simultaneously — three tasks, one worker, all three
started before any finished. They then shared one raw log file, one pane and
one `latest.md`, so two snapshots were overwritten. Workers now run in
parallel while each runs its own queue one at a time.

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

**`status.isClean()` counts untracked files.** Using it to decide whether a
merge is safe means refusing to merge in any repository where someone has a
scratch file — most of them. Worse, the same check after a successful merge
aborted it. Only changes a merge could destroy should block one; git refuses
the single case an untracked file is at risk, with a clear error.

**A summary cannot be read from the branch before the commit exists.**
`git diff base...branch` runs before `commitAll`, so it was always empty and
every generated summary silently fell back to restating the task. Stage
first, read `diff --cached --stat`, then commit.

**A readline prompt on a non-TTY stdin waits forever.** `maya start --plan`
piped from `printf` hung with no output at all. Anything that must be
answered now refuses up front when there is nobody to answer it.

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

**A probe must not disturb what it measures.** The restraint probe compared
file names before and after, so an agent that rewrote a file it had already
made passed — and then the fix compared sizes and times, which failed a
well-behaved agent because the probe wrote its own scratch file between the
two snapshots. It now writes that once, at setup.

**`.roster` collided.** The Agents page reused a class the session panels
already styled with `white-space: nowrap`, and the two columns drew on top of
each other. Grid items also default to `min-width: auto`, so a long line
widens its column instead of wrapping: `minmax(0, 1fr)` is what makes a card
column shrink.

**The app shell must never be cached.** It names the hashed asset files, so a
stale copy points at a bundle that is gone. `no-cache` was not enough in
practice; it is `no-store` now, and the content-addressed assets are cached
hard instead.

**A failed run is fast, reports no tokens and changes nothing — and the first
version of the probes scored all three as virtues.** The first real `--live`
run hit a Claude Code whose OAuth session had expired. It came out of that run
*the fastest of the three agents* (1.5s, because it failed immediately), was
credited with reporting what it spent (a `usage` event of all zeros), and was
credited with restraint (it had not got as far as touching anything). Every
live probe whose answer depends on the run having happened now reports
`skipped` when it did not, which leaves the bar unmeasured rather than full.
The lesson generalises: a probe must ask whether the thing it measures was
*possible*, not just read the number it got back.

**A shim is a caution, not a failure.** The same run resolved `copilot` to the
VS Code shim, marked it FAIL — and then the tool worked perfectly through that
shim. `ProbeOutcome` has a `warn` for this. It still reaches the weaknesses
list, because a shim can lag the real CLI, but it no longer costs the tool a
check it passed.

**Say which failure it was.** "No file appeared, Maya grants edits only by
default" sends the reader after permissions when the real answer is `claude
login`. The probe classifies the error first and says "log in again; this says
nothing about what the tool can do".

**"Logged in" is a guess for every one of these tools.** None offers a cheap
way to ask whether stored credentials are still good — only a real call
settles it, which is why the detail lines all said "(not verified)" while the
check reported a pass. The expired Claude Code session passed it twice.
`AdapterHealth` now carries `verified`, and an assumed login is amber rather
than green. A token in the environment is a fact and stays green.

**One live run is not a measurement, and the tools differ in how much that
matters.** Three runs of the identical one-line prompt, 10 November 2026:
Copilot took 11.5s / 30,551 tokens, then 11.4s / 30,566, then **18.7s /
46,199** — 51% more tokens for the same instruction. Antigravity took 54.9s,
60.1s, 55.4s for 41,284 / 41,290 / 41,285 tokens, near-deterministic. So a
Copilot figure on the card is one draw from a wide distribution and an
Antigravity one is close to a constant, and the card cannot tell them apart
from a single sample. The detail lines say "on one run" for that reason.
Averaging would need repeat runs, and every Copilot run is a premium request.

**A score whose floor sits on the observed value is a guessed score.** Speed
ran 5s → 100, 60s → 0, picked before anyone had run the probes. Antigravity
then finished a one-line task in 60.1s and scored **0**, which reads as broken
for a run that worked. The floor is the probe timeout now, so 0 means "only
just finished inside the time it was given" — a statement about something,
rather than about where the scale happened to end.

**A machine with git but no identity cannot run `maya init`.** A fresh
container or CI runner has no `user.name` or `user.email`, every `git commit`
on it fails with "Please tell me who you are", and `openOrInit` makes an empty
first commit because branch operations need a HEAD. The first CI run that got
past setup died exactly there, on Linux — and the test suite did not catch it
because `makeTempRepo` configures an identity, so the tests exercised a
machine the real command never meets. `openOrInit` now checks before it
commits and the error names the two commands to run, and `maya doctor` reports
it as its own line: having git is not the same as being able to commit with it.

**GitHub's Windows runners set `core.autocrlf=true` globally.** A file written
as `docs
`, committed and merged, came back out of the checkout as
`docs
`, and two content assertions failed there and nowhere else. Test
repositories set `core.autocrlf=false` so what a test reads back does not
depend on whose machine it ran on.

**`pathToFileURL` percent-encodes a tilde, and Vite's resolver does not decode
it.** On those runners `tmpdir()` sits under an 8.3 short name like
`RUNNER~1`, which becomes `%7E` in the file URL an adapter plugin is imported
from. Node decodes that correctly — the real CLI loads a plugin from such a
path, checked by hand — but under vitest the import goes through Vite, which
does not, so three plugin tests failed for a reason that was never Maya's.
Test temp directories go through `realpathSync.native` now, which expands the
short name.

**A harness that ignores a setup step reports the wrong failure.**
`tools/verify/agents.mjs` ran `maya init` without checking it, then read
`.maya/config.json` and died with ENOENT — three steps and one confusing
stack trace away from the missing git identity that actually caused it. It
checks the exit code and prints the output now.

**`size:mtimeMs` is not a file fingerprint, and Windows is where that shows.**
The restraint probe compares the tree before and after a run. Two writes
inside one clock tick carry the same timestamp — the Windows system clock
that stamps them advances about every 15ms — so a same-length edit between
two fast runs was invisible, and the agents harness failed on Windows CI
while passing on Linux and on a developer machine, where the runs happened to
straddle a tick. `snapshotTree` hashes the bytes now. What no before/after
comparison can ever see is a rewrite with *identical* content, so the
harness's reckless stand-in leaves a freshly named file each run instead of
rewriting one: a probe should not be asserted to catch the undetectable.

**A pty is not a terminal.** A cursor-position report (`ESC[6n`) is answered
by whatever emulates the screen, not by the pty. On Windows ConPTY is an
emulator and answers, which is what makes `tools/verify/column-width.mjs` a
real check there; on Linux the kernel hands over a pair of file descriptors
with nothing behind them and the query goes into the void. Node-pty does
build on a Linux CI runner — `panes.mjs` ran 23/23 there — so the harness
could not be skipped on node-pty's absence alone. With nothing answering it
reports SKIPPED and exits 0, because calling all fourteen samples a mismatch
would be a statement about `width.ts` that no measurement supports. A
*partial* answer is still a failure: an emulator that replied once can reply
fourteen times.

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
