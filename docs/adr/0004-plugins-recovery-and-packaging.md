# 4. Adapter plugins, non-destructive recovery, and a bundled CLI

Date: 2026-11-09
Status: accepted

Three hardening decisions, each with a trade worth recording.

## Adapter plugins run code the config names

A project adds a tool by naming a module in `.maya/config.json`; Maya imports
it and calls the export. That is the feature — adding a tool without changing
Maya — and it is also arbitrary code execution driven by a file on disk.

What makes it acceptable rather than reckless:

- It is **opt-in and empty by default**. No `adapters` list, no loading.
- `.maya/` is in `.git/info/exclude`, so the list is written locally and is
  not something a clone carries in.
- **Every module path is printed as it loads**, by `maya doctor`, `maya run`
  and in the Operator pane. A plugin cannot be added quietly.
- A plugin that fails is reported, not thrown: one bad entry should not stop a
  session whose other workers are fine. A worker that actually needs the
  missing adapter still fails, because the registry has no adapter under that
  id and says so.
- A plugin whose adapter registers a different id than the config declares is
  refused, since worker profiles resolve by that name and the mismatch would
  register it under something nothing looks up.

The honest summary: **the `adapters` list is as trusted as the code in the
repository it sits in.** That is the right bar for a tool you point at your own
project, and the wrong bar for running Maya against a repository you do not
trust. It is written down rather than designed around.

`AgentToolId` widened from a union of the three built-ins to
`BuiltInToolId | (string & {})`, which keeps the built-in ids as completions
without closing the type to ids a project invents.

## Recovery deletes nothing

A daemon that died leaves three things: a lock naming a dead process, tasks the
queue still calls `running`, and worktrees under `.maya/worktrees`.

The first two are cleaned up at the next daemon start, when by definition
nothing of the new session is running yet, so anything still marked running
belongs to a process that is gone. Leaving them makes the To-Do panel claim
work is in flight forever.

The third is **reported and left alone**. `git worktree prune` runs, but it
only drops metadata for directories that have already disappeared. A worktree
still on disk is exactly where a crash mid-run leaves work the agent wrote and
nobody committed, and deleting it on startup would destroy it to tidy up.
`maya doctor` names the directories; removing them is the user's call.

## The CLI is bundled, not published

`pnpm package` produces `dist/maya`: one esbuild bundle, the web client beside
it, and a `package.json` naming only what cannot be inlined — better-sqlite3
and node-pty load native binaries, and the Agent SDK resolves files relative to
its own package directory.

This keeps the workspace layout for development and gives one directory that
runs anywhere, without deciding to publish the packages. `tools/verify/packaged.mjs`
copies the bundle to a temp directory with only its declared dependencies and
drives it from an unrelated cwd — which is the only way to catch a path
resolved against the workspace instead of the bundle. `findWebClient()` gained
a candidate for the bundled layout for exactly that reason.

**Linux is unverified.** Everything here was built and run on Windows. The code
avoids platform assumptions and the native dependencies are either optional
(node-pty, which has no Linux prebuild) or prebuilt for Linux
(better-sqlite3), but that is reasoning, not evidence. Someone should run the
suite and `tools/verify/packaged.mjs` on Linux before Maya is called
cross-platform.

> **Settled, 2026-11-11.** `.github/workflows/ci.yml` does this on every push
> and both legs pass, `tools/verify/packaged.mjs` among them (12/12 on Linux).
> The reasoning above held up in substance but not in its predictions: what
> broke was a git identity missing on a fresh runner, `core.autocrlf` on
> GitHub's Windows images, a tilde in an 8.3 path defeating Vite's resolver,
> and two checks measuring the machine rather than Maya. `docs/FINDINGS.md`
> has each one. Kept as written, because the point of an ADR is what was known
> at the time.
