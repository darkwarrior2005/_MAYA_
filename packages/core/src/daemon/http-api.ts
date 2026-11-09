import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, relative, resolve, sep } from "node:path";
import type { SimpleGit } from "simple-git";
import type { MayaConfig } from "../config/maya-config.js";
import type { EventBus } from "../bus/event-bus.js";
import type { EventStore } from "../bus/event-store.js";
import { buildFileTree } from "../git/file-tree.js";
import { buildGraph } from "../git/graph-builder.js";
import { TaskQueue } from "../orchestrator/task-queue.js";

export interface WebApiDeps {
  repoRoot: string;
  git: SimpleGit;
  store: EventStore;
  bus: EventBus;
  config: MayaConfig;
  /** Directory of the built web client. Omitted means it was never built. */
  clientDir?: string;
}

/** Largest request body accepted. The only POST carries one chat line. */
const MAX_BODY_BYTES = 64 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The read side of the web interface, plus one route for sending a chat
 * message. Served by the daemon itself on the same port as the WebSocket, so
 * `/localhost` has one address to open and there is one process to stop.
 *
 * Written against `node:http` rather than a framework: this is five read-only
 * routes and a static directory on a loopback-bound server, and the CLI — which
 * may never serve a page — would otherwise carry a web stack in its install.
 */
export function createApiHandler(deps: WebApiDeps) {
  const clientRoot = deps.clientDir ? resolve(deps.clientDir) : undefined;

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = url.pathname;

    try {
      if (route.startsWith("/api/")) {
        await handleApi(route, url, request, response, deps);
        return;
      }
      serveClient(route, response, clientRoot);
    } catch (error) {
      // A browser showing a blank page with no explanation is the worst
      // outcome here, so the reason always reaches the client.
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

async function handleApi(
  route: string,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
  deps: WebApiDeps,
): Promise<void> {
  if (route === "/api/session" && request.method === "GET") {
    const [branch, status] = await Promise.all([
      deps.git.revparse(["--abbrev-ref", "HEAD"]).catch(() => "HEAD"),
      deps.git.status().catch(() => undefined),
    ]);
    send(response, 200, {
      repoRoot: deps.repoRoot,
      branch: branch.trim(),
      clean: status?.isClean() ?? null,
      changedFiles: status ? status.files.length : null,
      operator: deps.config.operator,
      workers: deps.config.workers,
      latestEventId: deps.store.latestId(),
    });
    return;
  }

  if (route === "/api/graph" && request.method === "GET") {
    const limit = Number(url.searchParams.get("limit") ?? "");
    send(
      response,
      200,
      await buildGraph(deps.git, Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    );
    return;
  }

  if (route === "/api/files" && request.method === "GET") {
    send(response, 200, await buildFileTree(deps.git));
    return;
  }

  if (route === "/api/events" && request.method === "GET") {
    const since = Number(url.searchParams.get("since") ?? "0");
    send(response, 200, deps.store.since(Number.isFinite(since) ? since : 0));
    return;
  }

  if (route === "/api/tasks" && request.method === "GET") {
    send(response, 200, new TaskQueue(deps.store.database).all());
    return;
  }

  if (route === "/api/message" && request.method === "POST") {
    const body = await readBody(request);
    if (body === null) {
      send(response, 413, { error: `body larger than ${MAX_BODY_BYTES} bytes` });
      return;
    }
    let text = "";
    try {
      text = String((JSON.parse(body) as { text?: unknown }).text ?? "").trim();
    } catch {
      send(response, 400, { error: "expected JSON with a text field" });
      return;
    }
    if (!text) {
      send(response, 400, { error: "text is required" });
      return;
    }
    // Onto the same bus the CLI publishes to, which is what makes a line typed
    // in one interface appear in the other.
    const event = deps.bus.publish("main", null, "user_message", { type: "user_message", text });
    send(response, 200, { id: event.id });
    return;
  }

  send(response, 404, { error: `no route ${route}` });
}

function serveClient(route: string, response: ServerResponse, clientRoot: string | undefined): void {
  if (!clientRoot || !existsSync(clientRoot)) {
    send(response, 503, {
      error: "the web client has not been built",
      hint: "run `pnpm build` at the repository root, then reload",
    });
    return;
  }

  const file = resolveWithin(clientRoot, route);
  // Any path that is not a real file falls through to the app shell, so a
  // client-side route survives a reload.
  const target = file && isFile(file) ? file : join(clientRoot, "index.html");
  if (!isFile(target)) {
    send(response, 503, { error: "the web client build is missing index.html" });
    return;
  }

  response.writeHead(200, {
    "content-type": MIME[extname(target).toLowerCase()] ?? "application/octet-stream",
    // The daemon is per-session and short-lived; a cached stale bundle would
    // be served after a rebuild.
    "cache-control": "no-cache",
  });
  createReadStream(target).pipe(response);
}

/**
 * Resolves a request path inside the client directory, or null if it escapes.
 *
 * Checked with `relative` rather than a string prefix: on Windows a prefix
 * comparison has to contend with case and with `C:\dir` matching `C:\dir-evil`,
 * and this server is reachable by anything running on the machine.
 */
export function resolveWithin(root: string, route: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(route);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;

  const candidate = resolve(root, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  if (candidate === root) return root;
  const inside = relative(root, candidate);
  if (inside === "" || inside.startsWith("..") || inside.startsWith(`${sep}..`)) return null;
  // An absolute result means `candidate` is on another drive entirely.
  return /^[a-zA-Z]:[\\/]/.test(inside) || inside.startsWith(sep) ? null : candidate;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  response.end(json);
}

/** Returns null when the body exceeds the cap, rather than buffering it. */
function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolveBody(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
