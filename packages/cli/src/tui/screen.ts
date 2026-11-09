import type { TerminalSize } from "./layout.js";

const ALT_SCREEN_ON = "\u001b[?1049h";
const ALT_SCREEN_OFF = "\u001b[?1049l";
const AUTOWRAP_OFF = "\u001b[?7l";
const AUTOWRAP_ON = "\u001b[?7h";
const CURSOR_HIDE = "\u001b[?25l";
const CURSOR_SHOW = "\u001b[?25h";
const CLEAR = "\u001b[2J";
const HOME = "\u001b[H";

/** How often the reported terminal size is checked; see `start`. */
const SIZE_POLL_MS = 250;

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
  private readonly restore = (): void => this.close();

  constructor(private readonly io: ScreenIo = { stdout: process.stdout, stdin: process.stdin }) {}

  get interactive(): boolean {
    return this.io.stdout.isTTY === true && this.io.stdin.isTTY === true;
  }

  size(): TerminalSize {
    return {
      cols: this.io.stdout.columns ?? 80,
      rows: this.io.stdout.rows ?? 24,
    };
  }

  start(onKey: (chunk: string) => void, onResize: () => void): void {
    if (this.open) return;
    this.open = true;

    this.io.stdout.write(ALT_SCREEN_ON + AUTOWRAP_OFF + CURSOR_HIDE + CLEAR);

    if (this.io.stdin.isTTY) this.io.stdin.setRawMode(true);
    this.io.stdin.resume();
    this.io.stdin.setEncoding("utf8");
    this.keyHandler = onKey as (chunk: unknown) => void;
    this.io.stdin.on("data", this.keyHandler);

    this.resizeHandler = onResize;
    this.io.stdout.on("resize", onResize);

    // Windows does not deliver a "resize" event on stdout under ConPTY, so the
    // event alone leaves the panes drawn at the old size until something else
    // happens to trigger a frame. Polling the reported size is the only
    // portable way to notice, and it costs two property reads.
    let last = this.size();
    this.sizePoll = setInterval(() => {
      const now = this.size();
      if (now.cols === last.cols && now.rows === last.rows) return;
      last = now;
      onResize();
    }, SIZE_POLL_MS);
    this.sizePoll.unref();

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
    frame += cursor
      ? `\u001b[${cursor.row + 1};${cursor.col + 1}H${CURSOR_SHOW}`
      : CURSOR_HIDE;
    this.io.stdout.write(frame);
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    if (this.sizePoll) clearInterval(this.sizePoll);
    this.sizePoll = undefined;
    if (this.resizeHandler) this.io.stdout.off("resize", this.resizeHandler);
    if (this.keyHandler) this.io.stdin.off("data", this.keyHandler);
    this.keyHandler = undefined;
    if (this.io.stdin.isTTY) this.io.stdin.setRawMode(false);
    this.io.stdin.pause();
    this.io.stdout.write(CURSOR_SHOW + AUTOWRAP_ON + ALT_SCREEN_OFF);
    this.lastFrame = [];
    this.needsClear = true;
  }
}
