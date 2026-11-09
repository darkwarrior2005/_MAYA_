import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface DaemonLock {
  pid: number;
  port: number;
  startedAt: string;
}

export class NoDaemonError extends Error {
  constructor(projectRoot: string, detail: string) {
    super(
      `no Maya session is running for ${projectRoot} (${detail}). ` +
        "Start one with `maya web -d <project>` or `maya start --tui <task>`, then try again.",
    );
    this.name = "NoDaemonError";
  }
}

/**
 * Talks to a project's Maya daemon over its HTTP API.
 *
 * Over HTTP rather than by opening the event store, because only the daemon's
 * process writes to the bus: a row inserted from outside reaches no connected
 * view and is skipped permanently, since every view resumes from its own
 * high-water mark. The daemon is also the only thing that knows whether a
 * merge question is still waiting.
 *
 * The lock is re-read on every call — a daemon that restarted is on a new
 * port, and an agent's session outlives any one of Maya's.
 */
export class MayaClient {
  constructor(private readonly projectRoot: string) {}

  static forProject(dir: string | undefined): MayaClient {
    return new MayaClient(resolve(dir ?? process.env["MAYA_PROJECT"] ?? process.cwd()));
  }

  get root(): string {
    return this.projectRoot;
  }

  /** Where the daemon is, or an error explaining how to start one. */
  address(): string {
    const lockFile = join(this.projectRoot, ".maya", "daemon.lock");
    if (!existsSync(lockFile)) throw new NoDaemonError(this.projectRoot, "no daemon.lock");

    let lock: DaemonLock;
    try {
      lock = JSON.parse(readFileSync(lockFile, "utf8")) as DaemonLock;
    } catch {
      throw new NoDaemonError(this.projectRoot, "daemon.lock is unreadable");
    }

    try {
      // Signal 0 asks whether the process exists without touching it.
      process.kill(lock.pid, 0);
    } catch {
      throw new NoDaemonError(this.projectRoot, `the recorded process ${lock.pid} is gone`);
    }
    return `http://127.0.0.1:${lock.port}`;
  }

  async get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.address()}${path}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(await describe(response, path));
    return (await response.json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.address()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(await describe(response, path));
    return (await response.json()) as T;
  }
}

async function describe(response: Response, path: string): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `${path} returned ${response.status}`;
}
