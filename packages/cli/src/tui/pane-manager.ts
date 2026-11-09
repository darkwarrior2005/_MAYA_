import type { DeferredConflictResolver } from "@maya/core";
import type { BusEvent } from "@maya/shared-types";
import { BusClient } from "./bus-client.js";
import { decodeKeys, type Key } from "./keys.js";
import {
  MIN_PANE_HEIGHT,
  pickCharset,
  renderLayout,
  type Charset,
  type LayoutInput,
} from "./layout.js";
import { openBrowser } from "./open-browser.js";
import { OPERATOR_PANE, PaneStore, type PaneSpec } from "./pane-state.js";
import { Screen } from "./screen.js";
import { isSlashCommand, runSlashCommand } from "./slash-commands.js";

export interface PaneManagerOptions {
  daemonAddress: string;
  operator: PaneSpec;
  workers: PaneSpec[];
  /** Puts what the user typed onto the bus, when the host supports it. */
  onUserMessage?: (text: string) => void;
  /** Lets the user answer the Operator's merge questions from the prompt. */
  conflicts?: DeferredConflictResolver;
  screen?: Screen;
  charset?: Charset;
}

/**
 * The tmux-style view from the wireframe: the Operator in the main pane, the
 * workers in panes below, one prompt line for the user.
 *
 * The panes show the normalized event stream, not raw terminal output, because
 * that is what the agents actually produce — the Claude Code adapter runs
 * in-process and the subprocess adapters are driven over pipes, so there is no
 * interactive terminal per worker to attach to. The upside is that the CLI and
 * the web client render the same events from the same socket; the cost is that
 * a worker pane is a live transcript rather than a shell you can type into.
 */
export class PaneManager {
  private readonly store: PaneStore;
  private readonly screen: Screen;
  private readonly charset: Charset;
  private readonly bus: BusClient;
  private input = "";
  private running = false;
  private frameTimer: NodeJS.Timeout | undefined;
  private exit: (() => void) | undefined;

  constructor(private readonly options: PaneManagerOptions) {
    this.store = new PaneStore(options.operator, options.workers);
    this.screen = options.screen ?? new Screen();
    this.charset = options.charset ?? pickCharset();
    this.bus = new BusClient({
      address: options.daemonAddress,
      since: () => this.store.lastSeenId,
      onEvent: (event) => this.onEvent(event),
      onNotice: (text) => {
        this.store.note(text);
        this.schedule();
      },
    });
  }

  get interactive(): boolean {
    return this.screen.interactive;
  }

  /** False once the user has left the pane view. */
  get active(): boolean {
    return this.running;
  }

  /** Resolves when the user leaves the pane view. */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;

    this.store.note(`maya panes — daemon ${this.options.daemonAddress}`);
    this.store.note("/help for commands, Tab to switch panes, Ctrl-C to leave");

    this.screen.start(
      (chunk) => this.onInput(chunk),
      // A resized console has reflowed the old frame and may be left with rows
      // the new, shorter frame does not cover, so repaint from a clean screen.
      () => this.redraw(),
    );
    this.bus.start();
    this.draw();

    return new Promise<void>((resolve) => {
      this.exit = resolve;
    });
  }

  /** Writes a line into the Operator pane from the host, e.g. a run summary. */
  announce(text: string): void {
    this.store.note(text);
    this.schedule();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = undefined;
    this.bus.stop();
    this.screen.close();
    // A question still on screen would otherwise block the Operator forever.
    this.options.conflicts?.abandon();
    this.exit?.();
    this.exit = undefined;
  }

  private onEvent(event: BusEvent): void {
    this.store.apply(event);
    this.schedule();
  }

  private onInput(chunk: string): void {
    for (const key of decodeKeys(chunk)) this.onKey(key);
    this.schedule();
  }

  private onKey(key: Key): void {
    const focused = this.store.focused;
    const page = Math.max(1, this.paneBodyHeight());

    switch (key.name) {
      case "ctrl-c":
      case "ctrl-d":
        this.stop();
        return;
      case "enter":
        void this.submit();
        return;
      case "backspace":
        this.input = [...this.input].slice(0, -1).join("");
        return;
      case "ctrl-u":
        this.input = "";
        return;
      case "tab":
        this.store.cycleFocus(1);
        return;
      case "shift-tab":
        this.store.cycleFocus(-1);
        return;
      case "up":
        focused.scrollOffset += 1;
        return;
      case "down":
        focused.scrollOffset = Math.max(0, focused.scrollOffset - 1);
        return;
      case "page-up":
        focused.scrollOffset += page;
        return;
      case "page-down":
        focused.scrollOffset = Math.max(0, focused.scrollOffset - page);
        return;
      case "end":
        focused.scrollOffset = 0;
        return;
      case "ctrl-l":
        this.redraw();
        return;
      case "escape":
        this.input = "";
        return;
      case "char":
        this.input += key.text ?? "";
        return;
      default:
        return;
    }
  }

  private async submit(): Promise<void> {
    const line = this.input.trim();
    this.input = "";
    if (line === "") return;

    // A pending merge question owns the prompt: answering it is the only thing
    // the Operator is waiting for, and treating "2" as a new task would lose
    // the answer and leave the merge blocked.
    const conflicts = this.options.conflicts;
    if (conflicts?.pending && !isSlashCommand(line)) {
      this.store.note(`you: ${line}`);
      conflicts.answer(line);
      this.schedule();
      return;
    }

    if (isSlashCommand(line)) {
      await runSlashCommand(
        line,
        {
          daemonAddress: this.options.daemonAddress,
          note: (text) => this.store.note(text),
          focus: (index) => this.store.focus(index),
          paneTitles: this.store.panes.map((pane) => pane.title),
          quit: () => this.stop(),
          openBrowser,
        },
        () => {
          const pane = this.store.focused;
          pane.lines.length = 0;
          pane.scrollOffset = 0;
        },
      );
      this.schedule();
      return;
    }

    if (this.options.onUserMessage) {
      this.options.onUserMessage(line);
      return;
    }
    this.store.note("nothing is waiting on input right now — /help for commands");
    this.schedule();
  }

  /** Repaints from a cleared terminal rather than over the last frame. */
  private redraw(): void {
    this.screen.invalidate();
    this.draw();
  }

  /** Coalesces a burst of events into one frame. */
  private schedule(): void {
    if (!this.running || this.frameTimer) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = undefined;
      this.draw();
    }, 16);
    this.frameTimer.unref();
  }

  private paneBodyHeight(): number {
    const { rows } = this.screen.size();
    const band = this.options.workers.length > 0 ? Math.floor((rows - 2) / 2) : rows - 2;
    return Math.max(1, band - 2);
  }

  private draw(): void {
    if (!this.running) return;
    const size = this.screen.size();
    const views = this.store.views();
    const pending = this.options.conflicts?.pending;

    const banner = pending
      ? [
          `? ${pending.question}`,
          ...pending.options.map(
            (option, index) =>
              `  ${index + 1}. ${option.label}${option.proposedBy ? ` (${option.proposedBy})` : ""}`,
          ),
          "  or type your own answer",
        ]
      : undefined;

    const promptLabel = pending ? "answer> " : "> ";
    // Keep the caret visible on a long line by showing the tail of the input.
    const room = Math.max(1, size.cols - promptLabel.length - 1);
    const shown = [...this.input].slice(-room).join("");

    const layout: LayoutInput = {
      operator: views.operator,
      workers: views.workers,
      ...(banner ? { banner } : {}),
      promptLabel,
      prompt: shown,
      status: this.statusLine(),
    };

    this.screen.render(renderLayout(layout, size, this.charset), {
      row: Math.max(0, size.rows - 2),
      col: Math.min(size.cols - 1, promptLabel.length + [...shown].length),
    });
  }

  private statusLine(): string {
    const panes = this.store.panes;
    const focused = panes[this.store.focusedIndex];
    const where = focused?.id === OPERATOR_PANE ? "operator" : (focused?.id ?? "operator");
    const scroll = focused && focused.scrollOffset > 0 ? "  [scrolled]" : "";
    return `maya  ${this.options.daemonAddress}  pane ${this.store.focusedIndex + 1}/${panes.length} ${where}${scroll}  Tab=switch  /help`;
  }
}

/** The smallest terminal the layout can draw the Operator plus one worker in. */
export const MIN_TERMINAL_ROWS = MIN_PANE_HEIGHT * 2 + 2;
