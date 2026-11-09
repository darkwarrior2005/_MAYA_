import { WebSocket } from "ws";
import type { BusEvent, ServerMessage } from "@maya/shared-types";

export interface BusClientOptions {
  /** Base daemon address, e.g. http://127.0.0.1:51234. */
  address: string;
  /** Read fresh on every connect so a reconnect resumes where the view is. */
  since: () => number;
  onEvent: (event: BusEvent) => void;
  onNotice: (text: string) => void;
  retryMs?: number;
}

/**
 * The pane view is a WebSocket client of the daemon even when it runs in the
 * same process, so the CLI and the web client see the session through exactly
 * one path. Each connect asks for everything after the last id this view
 * rendered, which is what keeps a dropped socket from leaving a silent gap.
 */
export class BusClient {
  private socket: WebSocket | undefined;
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(private readonly options: BusClientOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;

    socket.removeAllListeners();
    // Closing a socket that is still shaking hands makes ws raise "WebSocket
    // was closed before the connection was established". With our listeners
    // already gone that lands as an uncaught exception, so quitting the pane
    // view in the first moments of a run would take the process down with it.
    socket.on("error", () => undefined);
    if (socket.readyState === socket.CONNECTING) socket.terminate();
    else socket.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const base = this.options.address.replace(/^http/, "ws");
    const socket = new WebSocket(`${base}/ws?since=${this.options.since()}`);
    this.socket = socket;

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(String(data)) as ServerMessage;
        // Signals say something outside the event log changed. The panes show
        // the log, so there is nothing here to redraw for one.
        if (message.kind === "event") this.options.onEvent(message.event);
      } catch {
        // A frame we cannot parse is a daemon-side bug, not a reason to tear
        // down a working view; the raw logs are where it gets diagnosed.
        this.options.onNotice("dropped an unreadable event from the daemon");
      }
    });

    socket.on("error", (error: Error) => this.options.onNotice(`bus: ${error.message}`));
    socket.on("close", () => {
      if (this.stopped) return;
      this.options.onNotice("bus disconnected — retrying");
      this.retry();
    });
  }

  private retry(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), this.options.retryMs ?? 1000);
    // A pending retry must not be the reason the process stays alive.
    this.timer.unref();
  }
}
