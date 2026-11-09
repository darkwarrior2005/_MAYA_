# 2. Measure the terminal for its size rather than asking the OS

Date: 2026-11-09
Status: accepted

## Context

The pane view has to know how wide and tall the terminal is, and has to notice
when that changes. The normal way is `process.stdout.columns` / `.rows` plus the
`resize` event.

That does not work on Windows. Measured directly, under a pseudoconsole:

- the child process keeps reporting the size the console had when it started —
  110x30 after the pseudoconsole was resized to 70x18;
- no `resize` event is emitted;
- `CSI 18 t`, "report the text area size in characters", is consumed by ConPTY
  and never answered.

ConPTY is what every modern Windows terminal uses, so this is the normal case on
Windows and not an edge case. Panes stuck at the startup size for the rest of a
session is not a cosmetic problem: a frame wider than the terminal wraps, and
wrapping scrolls the whole screen on every paint.

One further measurement settled it: ConPTY **does** answer `CSI 6n`, the cursor
position report, and answers with the true size both before and after a resize
(`[30;110R`, then `[18;70R`).

## Decision

Maya measures the terminal rather than asking the OS. Four times a second it
writes `ESC 7`, `CSI 999;999H`, `CSI 6n`, `ESC 8` — save the cursor, send it far
past the bottom-right corner, ask where it actually ended up, put it back — and
takes that answer over whatever Node reports.

The `resize` event and the polled `columns`/`rows` stay, as the fast path on
Linux and macOS and as the fallback for a terminal that answers neither.

The answer arrives on stdin, indistinguishable from typing, so `Screen` strips
cursor reports out of the input stream before the key decoder sees them. A
trailing incomplete escape sequence is held back for 40ms so a report split
across two reads is reassembled rather than half-typed into the user's prompt. A
bare `ESC` is not held back, because that is the Escape key and waiting on it
would make Escape feel broken.

## Consequences

- The panes follow a resized window on Windows, which they did not before.
- This is verifiable end to end without faking a terminal: the pseudoconsole
  answers the measurement itself, so `tools/verify/panes.mjs` shrinks and grows
  a real pseudoconsole and asserts the frame's width and height both times.
- Maya writes a few bytes to stdout four times a second while the panes are up.
- A terminal that answers neither the measurement nor the event, and whose
  reported size is also stale, will not notice a resize. Ctrl-L forces a
  repaint, which is what that key is for.
- Anything else that reads stdin while the panes are up would see the reports.
  Nothing does; `Screen` is the only reader.
