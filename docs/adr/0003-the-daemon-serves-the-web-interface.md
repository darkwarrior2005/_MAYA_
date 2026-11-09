# 3. The daemon serves the web interface, on one port, without a framework

Date: 2026-11-09
Status: accepted

## Context

The plan called for a `packages/web-server` built on Fastify with
`@fastify/static`, alongside the daemon that already owns the event bus and a
WebSocket on its own HTTP server.

Two things made that awkward once the daemon existed:

- **Two servers means two ports and two lifecycles.** `/localhost` in the pane
  view opens the port recorded in `.maya/daemon.lock`, and the whole point of
  the architecture is that the CLI and the web client are two views of one
  session. A second process serving the UI would need its own port, its own
  lock, its own shutdown, and a way to find the daemon's socket.
- **The CLI would carry a web stack.** `packages/cli` depends on
  `packages/core`. Putting Fastify in the daemon puts it in the install of
  someone who only ever runs `maya run`.

Against that: the HTTP surface is five read-only GETs, one POST carrying a
single chat line, and a static directory, all on a server bound to 127.0.0.1.

## Decision

The daemon serves the API, the built web client and the WebSocket on one port,
handled with `node:http` and no framework. There is no `packages/web-server`.
`packages/web-client` is a React + Vite app whose `dist` the daemon serves;
`findWebClient()` locates it and reports its absence as a 503 that says to run
`pnpm build`, because a checkout that has not been built is a normal state
rather than a startup error.

Static serving is the part that needed care rather than a library. Request
paths are resolved with `path.relative` and rejected if they climb out, instead
of a string-prefix check: on Windows a prefix comparison has to contend with
case and with `C:\dir` matching `C:\dir-evil`. Anything that is not a real file
inside the root falls through to the app shell, so a client-side route survives
a reload and a traversal attempt reaches the filesystem not at all.

**Durable events and transient signals are separate messages.** The socket
carries `{kind: "event", event}` for rows in the append-only log, replayable by
id, and `{kind: "signal", signal}` for "something changed, re-read it". The
file watcher emits a signal. Appending a row every time a file is saved would
fill the session log with things no one will ever replay, and would make a
long editing session look like session history.

## Consequences

- One port, one process, one thing to stop. `/localhost` needed no change.
- `maya web` serves a project without running a task; `maya start --tui` serves
  on the same port it already opened.
- **Only the daemon's process writes to the bus.** Another process can open the
  same SQLite file, but the daemon's in-process emitter is what pushes to
  connected views, so a row inserted from outside reaches nobody — and because
  clients resume from their own high-water mark, it is skipped permanently
  rather than caught up later. This was observed, not theorised: a test write
  made directly to the store never reached an open browser. `maya attach`
  therefore posts to `/api/message` instead of publishing locally.
- The file watcher uses `fs.watch` with `recursive: true` rather than a watcher
  library, because all it needs is "something changed". That works on Windows
  and macOS, and on Linux from Node 20.13; where it is unavailable the daemon
  says so on the bus and the tree is stale rather than broken.
- If the HTTP surface grows much past this — auth, sessions, uploads, many
  routes — the handler should become a framework rather than grow a router.
