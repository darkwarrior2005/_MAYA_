import type { TerminalSize } from "./layout.js";

const ALT_SCREEN_ON = "\u001b[?1049h";
const ALT_SCREEN_OFF = "\u001b[?1049l";
const AUTOWRAP_OFF = "\u001b[?7l";
const AUTOWRAP_ON = "\u001b[?7h";
const CURSOR_HIDE = "\u001b[?25l";
const CURSOR_SHOW = "\u001b[?25h";
const CLEAR = "\u001b[2J";
const HOME = "\u001b[H";

/**
 * Asks the terminal where the cursor is after being sent far past the
 * bottom-right corner, which is the portable way to measure a terminal when
 * the OS will not tell the process its size. The cursor is saved and restored
 * around it, so nothing moves on screen.
 *
 * `CSI 18 t` ("report text area size") would be more direct, but ConPTY
 * swallows it without answering. It does answer this one.
 */
const SIZE_PROBE = "\u001b7\u001b[999;999H\u001b[6n\u001b8";
/* eslint-disable no-control-regex -- matching terminal control sequences
   is the point here: these take the terminal's answers out of the input
   stream before the key decoder sees them. */
const CURSOR_REPORT = /\u001b\[(\d+);(\d+)R/g;

/** How often the terminal is measured; see `start`. */
const SIZE_POLL_MS = 250;

/**
 * How long a trailing, incomplete escape sequence is held back waiting for the
 * rest of it. Long enough to reassemble a split read, short enough that a real
 * keystroke never feels delayed.
 */
const PARTIAL_INPUT_MS = 40;

export interface CursorPosition {
  /** 0-based. */
  row: number;
  /** 0-based. */
  col: number;
}

export interface ScreenIo {
  stdout: NodeJS.WriteStream;
  stdin: NodeJS.ReadStream;
}

/**
 * Owns the terminal while the panes are up: alternate screen buffer, raw input,
 * and a single full-frame write per render.
 *
 * Restoring the terminal is handled on every exit path, including a crash. A
 * process that dies in the alternate buffer with raw mode on and the cursor
 * hidden leaves the user with a shell that echoes nothing — recoverable only
 * by `reset`, which most people do not know about.
 */
export class Screen {
  private open = false;
  private lastFrame: string[] = [];
  private needsClear = true;
  private resizeHandler: (() => void) | undefined;
  private keyHandler: ((chunk: unknown) => void) | undefined;
  private sizePoll: NodeJS.Timeout | undefined;
  private partial = "";
  private partialTimer: NodeJS.Timeout | undefined;
  private answered: TerminalSize | undefined;
  private notified: TerminalSize | undefined;
  private readonly restore = (): void => this.close();

  constructor(private readonly io: ScreenIo = { stdout: process.stdout, stdin: process.stdin }) {}

  get interactive(): boolean {
    return this.io.stdout.isTTY === true && this.io.stdin.isTTY === true;
  }

  /**
   * What the terminal reports wins over what Node reports. Under ConPTY —
   * which is every modern Windows terminal — `process.stdout.columns` and
   * `.rows` are frozen at the size the console had when the process started
   * and no "resize" event is ever emitted, so Node's values alone leave the
   * panes drawn at the wrong size for the rest of the session. Measured live,
   * the same terminal answers with its true size before and after a resize.
   */
  size(): TerminalSize {
    if (this.answered) return this.answered;
    return {
      cols: this.io.stdout.columns ?? 80,
      rows: this.io.stdout.rows ?? 24,
    };
  }

  /** True once the terminal has answered a measurement at least once. */
  get sizeFromTerminal(): boolean {
    return this.answered !== undefined;
  }

  start(onKey: (chunk: string) => void, onResize: () => void): void {
    if (this.open) return;
    this.open = true;

    this.io.stdout.write(ALT_SCREEN_ON + AUTOWRAP_OFF + CURSOR_HIDE + CLEAR);

    if (this.io.stdin.isTTY) this.io.stdin.setRawMode(true);
    this.io.stdin.resume();
    this.io.stdin.setEncoding("utf8");
    this.keyHandler = ((chunk: string) => this.onData(String(chunk), onKey)) as (
      chunk: unknown,
    ) => void;
    this.io.stdin.on("data", this.keyHandler);

    this.resizeHandler = onResize;
    // Fires on Linux and macOS, and immediately; kept as the fast path.
    this.io.stdout.on("resize", onResize);

    this.notified = this.size();
    this.sizePoll = setInterval(() => {
      this.askForSize();
      this.notifyIfResized();
    }, SIZE_POLL_MS);
    this.sizePoll.unref();
    this.askForSize();

    // "exit" covers a crash too, since an uncaught exception still exits.
    // Registering an uncaughtException handler here would instead swallow the
    // crash and leave Maya running with a half-drawn screen.
    process.once("exit", this.restore);
    process.once("SIGINT", this.restore);
    process.once("SIGTERM", this.restore);
  }

  /**
   * Forgets what is on screen, so the next render repaints from a cleared
   * terminal. Needed whenever the terminal's own contents stopped matching the
   * last frame: after a resize the console reflows the old lines and a shorter
   * frame leaves the surplus rows behind, and Ctrl-L exists precisely to repair
   * a screen something else has scribbled on.
   */
  invalidate(): void {
    this.lastFrame = [];
    this.needsClear = true;
  }

  render(lines: string[], cursor?: CursorPosition): void {
    if (!this.open) return;
    // A full-frame write is one syscall and cannot tear; a diff would save
    // bytes but the frame is a few kilobytes at most.
    const same =
      this.lastFrame.length === lines.length &&
      this.lastFrame.every((line, index) => line === lines[index]);

    let frame = "";
    if (!same) {
      if (this.needsClear) {
        frame += CLEAR;
        this.needsClear = false;
      }
      frame += HOME + lines.join("\n");
      this.lastFrame = [...lines];
    }
    frame += cursor ? `\u001b[${cursor.row + 1};${cursor.col + 1}H${CURSOR_SHOW}` : CURSOR_HIDE;
    this.io.stdout.write(frame);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    if (this.sizePoll) clearInterval(this.sizePoll);
    this.sizePoll = undefined;
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = undefined;
    this.partial = "";
    if (this.resizeHandler) this.io.stdout.off("resize", this.resizeHandler);
    if (this.keyHandler) this.io.stdin.off("data", this.keyHandler);
    this.keyHandler = undefined;
    if (this.io.stdin.isTTY) this.io.stdin.setRawMode(false);
    this.io.stdin.pause();
    this.io.stdout.write(CURSOR_SHOW + AUTOWRAP_ON + ALT_SCREEN_OFF);
    this.lastFrame = [];
    this.needsClear = true;
    this.answered = undefined;
    this.notified = undefined;
  }

  private askForSize(): void {
    if (!this.open || this.io.stdout.isTTY !== true) return;
    // A terminal that does not answer leaves `answered` unset, which is why
    // the polled fallback on Node's own values stays in place.
    this.io.stdout.write(SIZE_PROBE);
  }

  /**
   * Pulls the terminal's measurements out of the input stream before anything
   * else sees it. They arrive on stdin exactly like keystrokes, and typing
   * "[30;100R" into the user's prompt every quarter second would make the
   * pane view unusable.
   */
  private onData(chunk: string, onKey: (text: string) => void): void {
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = undefined;

    let pending = this.partial + chunk;
    this.partial = "";

    // Hold back a trailing sequence that is still arriving, so a report split
    // across two reads is reassembled rather than half-typed.
    const split = partialEscapeAt(pending);
    if (split >= 0) {
      this.partial = pending.slice(split);
      pending = pending.slice(0, split);
      this.partialTimer = setTimeout(() => {
        const held = this.partial;
        this.partial = "";
        this.partialTimer = undefined;
        if (held) onKey(held);
      }, PARTIAL_INPUT_MS);
      this.partialTimer.unref();
    }

    let resized = false;
    const keys = pending.replace(CURSOR_REPORT, (_match, rows: string, cols: string) => {
      const next = { rows: Number(rows), cols: Number(cols) };
      if (next.rows > 0 && next.cols > 0) {
        const changed = this.answered?.rows !== next.rows || this.answered?.cols !== next.cols;
        this.answered = next;
        resized = resized || changed;
      }
      return "";
    });

    if (keys) onKey(keys);
    // Report the change after the keys, so a resize never reorders input.
    if (resized) this.notifyIfResized();
  }

  /**
   * Announces a size change once, whichever source noticed it first. Both the
   * poll and the terminal's answer can see the same change, and repainting
   * twice for one resize is visible flicker.
   */
  private notifyIfResized(): void {
    const now = this.size();
    if (now.cols === this.notified?.cols && now.rows === this.notified?.rows) return;
    this.notified = now;
    this.resizeHandler?.();
  }
}

/**
 * Where a trailing escape sequence that has not finished arriving begins, or
 * -1. A bare ESC is not held back: it is the Escape key, and waiting on it
 * would make Escape feel broken.
 */
/* eslint-disable no-control-regex -- matching terminal control sequences
   is the point here: these take the terminal's answers out of the input
   stream before the key decoder sees them. */
function partialEscapeAt(chunk: string): number {
  const start = chunk.lastIndexOf("\u001b");
  if (start === -1) return -1;
  const tail = chunk.slice(start);
  if (tail === "\u001b") return -1;
  // Only CSI and SS3 introducers are worth waiting on; everything else is
  // either complete already or not a sequence Maya reads.
  if (!/^\u001b[[O]/.test(tail)) return -1;
  return /^\u001b(\[[0-9;?]*[ -/]*[@-~]|O[@-~])/.test(tail) ? -1 : start;
}
