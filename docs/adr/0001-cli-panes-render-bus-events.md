# 1. The CLI pane view renders bus events, not agent terminals

Date: 2026-11-09
Status: accepted

## Context

The plan for the CLI interface called for a thin terminal multiplexer built from
`node-pty` (a real PTY per agent) plus `blessed` for layout and `blessed-xterm`
for the terminal widget: Operator in the main pane, workers in panes below,
`/localhost` opening the web view.

By the time the panes were built, three things were true that were not when the
plan was written:

1. **There are no agent terminals to attach to.** The Claude Code adapter runs
   the SDK in-process, and the Copilot and Antigravity adapters are driven over
   pipes in a single `-p` invocation. Phase 2 established that the pipe
   transport is mandatory, not a preference: a console screen buffer hard-wraps
   the long JSON lines these tools emit, and a PTY-wrapped Copilot run once
   reported success while the chat log captured no text, no tool calls and no
   usage at all. There is no interactive shell per worker for a pane to host.
2. **A terminal-emulator widget therefore buys nothing**, and `blessed` is
   unmaintained with known trouble on Windows terminfo.
3. **`node-pty` is the top packaging risk and is no longer needed.** It ships
   prebuilt binaries for Windows and macOS but none for Linux, so any Linux
   install without a C++ toolchain would have had to compile it.

## Decision

The pane view is a WebSocket client of the project daemon, and each pane renders
the normalized `AgentEvent` stream for one agent. The renderer is written
directly against ANSI escape sequences — alternate screen buffer, raw-mode
input, one full-frame write per paint — with no TUI dependency.

`node-pty` moved to `optionalDependencies`. The `pty` transport still exists and
still works where the package is installed; asking for it without it present
fails with an explicit message rather than a module-resolution error.

The layout is a pure function from state and terminal size to a grid of plain
strings, every line exactly as wide as the terminal. That is what makes the
split rules, scrollback windows and truncation testable without a terminal.

## Consequences

- The CLI and the web client are literally two views of one session: same
  socket, same events, same replay-from-last-seen-id on reconnect.
- A worker pane is a live transcript, not a shell you can type into. All typed
  input goes to the prompt line, which is the Operator's — matching the brief,
  where workers ask the Operator rather than the user. A future adapter with a
  genuine interactive session can be given a pane that hosts it.
- Agent output is sanitized before it is drawn. It is arbitrary text and may
  contain escape sequences, which would otherwise repaint parts of the screen
  Maya did not draw, and would count toward a line's length while occupying no
  columns — silently mis-sizing every pane on the row.
- Everything in `plain()` and `sanitize()` matches control characters on
  purpose, so `no-control-regex` is disabled at those two functions only.

## Note on resizing

Windows does not deliver a `resize` event on `process.stdout` under ConPTY, so
the reported size is polled every 250ms as well; the event is kept because it
fires immediately on Linux and macOS. A resize repaints from a cleared screen
rather than over the last frame, because the console reflows the old lines and a
shorter frame does not cover the rows the old one occupied.

This is also the one thing that could not be verified mechanically: node-pty's
pseudoconsole does not propagate its size to the child process — the child keeps
reporting the original `columns`/`rows` and no event fires — so dragging a real
terminal window is still a manual check. What is covered is the mechanism (a
test changes the reported size and asserts a cleared repaint at the new width)
and the layout's correctness at arbitrary sizes.
