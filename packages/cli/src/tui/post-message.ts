/**
 * Sends a chat line to the daemon rather than writing it to the event store.
 *
 * Only the daemon's process writes to the bus. Another process can reach the
 * same SQLite file, but the daemon's in-process emitter is what pushes events
 * to connected views, so a row inserted from outside lands in the log and is
 * seen by nobody until something reconnects. Posting keeps one writer and one
 * notification path.
 */
export async function postMessage(daemonAddress: string, text: string): Promise<void> {
  const response = await fetch(`${daemonAddress}/api/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `daemon refused the message (${response.status})`);
  }
}
