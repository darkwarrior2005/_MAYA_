import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import type { BusEvent } from "@maya/shared-types";
import type { EventBus } from "../bus/event-bus.js";
import type { EventStore } from "../bus/event-store.js";
import type { MayaPaths } from "../config/maya-config.js";

export interface DaemonLock {
  pid: number;
  port: number;
  startedAt: string;
}

export interface DaemonOptions {
  paths: MayaPaths;
  bus: EventBus;
  store: EventStore;
  port?: number;
}

/**
 * One daemon per project owns the bus; the CLI panes and the web client are
 * both just clients of it. That is what makes the two interfaces two views of
 * a single session rather than two separate sessions.
 */
export class Daemon {
  private http: Server | undefined;
  private wss: WebSocketServer | undefined;
  private port = 0;

  constructor(private readonly options: DaemonOptions) {}

  get address(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<DaemonLock> {
    const http = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ service: "maya", port: this.port }));
    });

    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(this.options.port ?? 0, "127.0.0.1", () => resolve());
    });

    const address = http.address();
    this.port = typeof address === "object" && address ? address.port : 0;
    this.http = http;

    const wss = new WebSocketServer({ server: http, path: "/ws" });
    wss.on("connection", (socket, request) => this.onConnection(socket, request.url ?? "/ws"));
    this.wss = wss;

    const lock: DaemonLock = {
      pid: process.pid,
      port: this.port,
      startedAt: new Date().toISOString(),
    };
    this.options.paths.ensureDirs();
    writeFileSync(this.options.paths.lockFile, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    return lock;
  }

  /**
   * Clients reconnect with the last event id they rendered and get everything
   * since, so a dropped socket cannot silently leave a view out of date.
   */
  private onConnection(socket: WebSocket, url: string): void {
    const lastSeen = Number(new URL(url, "http://localhost").searchParams.get("since") ?? 0);

    const send = (event: BusEvent): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    };

    const unsubscribe = this.options.bus.replayAndSubscribe(
      Number.isFinite(lastSeen) ? lastSeen : 0,
      send,
    );

    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  }

  async stop(): Promise<void> {
    this.wss?.clients.forEach((client) => client.terminate());
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
    });
    clearLock(this.options.paths);
  }
}

export function readLock(paths: MayaPaths): DaemonLock | null {
  if (!existsSync(paths.lockFile)) return null;
  try {
    return JSON.parse(readFileSync(paths.lockFile, "utf8")) as DaemonLock;
  } catch {
    return null;
  }
}

export function clearLock(paths: MayaPaths): void {
  try {
    unlinkSync(paths.lockFile);
  } catch {
    // nothing to clear
  }
}

/** A lock whose process is gone is stale, not a running daemon. */
export function isLockAlive(lock: DaemonLock): boolean {
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch {
    return false;
  }
}
