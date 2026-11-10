/**
 * Who is allowed to talk to the daemon.
 *
 * Binding to 127.0.0.1 keeps other machines out; it does nothing about the
 * browser already running on this one. A page on any origin can open a
 * WebSocket to localhost — sockets are not subject to the same-origin policy,
 * so the server has to check — and can send a form-shaped POST cross-origin
 * without a preflight, where CORS hides the *response* but not the effect.
 *
 * Measured against a running daemon before this existed: a page served from
 * another port read the whole event log, secret channel included, and posted
 * a chat message that landed in the log.
 *
 * A request with no `Origin` at all is allowed. That is the CLI, a script or
 * curl — all of which can already read `.maya/state.db` directly, so refusing
 * them would protect nothing. Browsers always send it on the requests that
 * matter here.
 */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined || origin === "") return true;
  // What a sandboxed iframe, a data: document or a file:// page sends.
  if (origin === "null") return false;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }

  if (parsed.port !== String(port)) return false;
  return LOOPBACK.has(parsed.hostname.toLowerCase());
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/**
 * Whether the request actually arrived at this machine under a loopback name.
 *
 * `Origin` alone does not close DNS rebinding: an attacker's domain can be
 * made to resolve to 127.0.0.1, and a page served from it reaches the daemon
 * with `Host: evil.example`. The browser considers that same-origin, so it
 * will happily read the response. Checking the Host header is the standard
 * answer, and it costs nothing: the daemon only ever listens on loopback, so
 * a Host that is not a loopback name did not come from a legitimate client.
 */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  // Strip the port, taking care with a bracketed IPv6 literal.
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : (host.split(":")[0] ?? "");
  const given = host.includes("]") ? host.slice(host.indexOf("]") + 2) : host.split(":")[1];
  if (given !== undefined && given !== "" && given !== String(port)) return false;
  return LOOPBACK.has(name.toLowerCase());
}

/** The 403 body, so the refusal explains itself rather than looking like a bug. */
export function originRefusal(what: string): { error: string } {
  return {
    error:
      `refused a request from ${what}: this daemon only answers its own ` +
      "web interface and local tools",
  };
}
