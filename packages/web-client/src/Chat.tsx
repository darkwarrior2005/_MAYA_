import { useEffect, useRef, useState, type ReactElement } from "react";
import type { BusEvent } from "@maya/shared-types";
import { sendMessage } from "./api.js";

export function Chat({ events }: { events: BusEvent[] }): ReactElement {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const log = useRef<HTMLDivElement>(null);

  // Follow new messages, unless the user has scrolled up to read something.
  useEffect(() => {
    const element = log.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    if (atBottom) bottom.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage(text);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  // The secret channel has its own panel. Repeating it here would put it back
  // in the Operator's transcript, which is the one thing it exists to avoid.
  const shown = events.filter(
    (event) => event.channel !== "secret" && describe(event) !== null,
  );

  return (
    <div className="chat">
      <div className="chat-log" ref={log}>
        {shown.length === 0 && <p className="empty">Nothing has happened in this session yet.</p>}
        {shown.map((event) => (
          <Line key={event.id} event={event} />
        ))}
        <div ref={bottom} />
      </div>

      <form
        className="composer"
        onSubmit={(submitEvent) => {
          submitEvent.preventDefault();
          void submit();
        }}
      >
        <input
          value={draft}
          onChange={(change) => setDraft(change.target.value)}
          placeholder="Say something to the session"
          aria-label="Message"
        />
        <button type="submit" disabled={sending || draft.trim() === ""}>
          Send
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Line({ event }: { event: BusEvent }): ReactElement {
  const described = describe(event);
  const who = event.agentId ?? "maya";

  return (
    <article className={`line line-${kind(event)}`}>
      <header>
        <span className="who">{who}</span>
        <time dateTime={event.createdAt}>{event.createdAt.slice(11, 19)}</time>
      </header>
      <p>{described}</p>
    </article>
  );
}

/** Which events are worth a line, and what it says. Null means "not shown". */
function describe(event: BusEvent): string | null {
  const payload = event.payload;
  switch (payload.type) {
    case "text":
      return payload.text.trim() || null;
    case "tool_call":
      return `used ${payload.toolName}`;
    case "tool_result":
      return payload.ok ? null : `${payload.toolName} failed`;
    case "status":
      return `${payload.status}${payload.detail ? ` — ${payload.detail}` : ""}`;
    case "error":
      return `${payload.fatal ? "error" : "warning"}: ${payload.message}`;
    case "done":
      return payload.ok ? "finished" : "finished with errors";
    case "user_message":
      return payload.text;
    case "agent_message":
      return payload.text;
    case "task_assigned":
      return `assigned to ${payload.agentId} on ${payload.branch}: ${payload.summary}`;
    case "task_completed":
      return `${payload.agentId} finished ${payload.ok ? "cleanly" : "with errors"}`;
    case "merge_result":
      return payload.merged
        ? `merged ${payload.branch}`
        : `merge blocked on ${payload.branch} (${payload.conflicts.join(", ") || "unclean tree"})`;
    case "conflict_prompt":
      return `needs a decision: ${payload.question}`;
    case "conflict_resolved":
      return `decided: ${payload.chosen}`;
    // Usage drives the info panel rather than the transcript.
    case "usage":
      return null;
    default:
      return null;
  }
}

function kind(event: BusEvent): string {
  const type = event.payload.type;
  if (type === "user_message") return "user";
  if (type === "error") return "error";
  if (type === "conflict_prompt") return "prompt";
  if (type === "task_assigned" || type === "task_completed" || type === "merge_result") {
    return "operator";
  }
  return "agent";
}
