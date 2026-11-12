import type { ReactElement } from "react";
import type { BusEvent, SessionInfo, TaskSpec, TokenUsage, UsageTotals } from "@maya/shared-types";

/** The "Agents To Do" panel: what has been handed out and where each task is. */
export function AgentsToDo({ tasks }: { tasks: TaskSpec[] }): ReactElement {
  if (tasks.length === 0) return <p className="empty">No tasks yet.</p>;

  return (
    <ul className="todo">
      {tasks.map((task) => (
        <li key={task.id}>
          <span className={`state state-${task.state}`}>{task.state}</span>
          <span className="summary" title={task.instruction}>
            {task.summary}
          </span>
          <span className="who">{task.assignedTo ?? "unassigned"}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The roster. Status is derived from the event stream rather than stored,
 * because what an agent is doing right now is exactly what the log describes.
 */
export function AgentsRoster({
  session,
  events,
}: {
  session: SessionInfo | null;
  events: BusEvent[];
}): ReactElement {
  if (!session) return <p className="empty">—</p>;

  const latest = new Map<string, string>();
  for (const event of events) {
    const agentId = event.agentId;
    if (!agentId) continue;
    if (event.payload.type === "status") latest.set(agentId, event.payload.status);
    if (event.payload.type === "done") {
      latest.set(agentId, event.payload.ok ? "done" : "error");
    }
  }

  const roles = [
    { ...session.operator, role: "operator", enabled: true },
    ...session.workers.map((worker) => ({ ...worker, role: "worker" })),
  ];

  return (
    <ul className="roster">
      {roles.map((agent) => (
        <li key={agent.id} className={agent.enabled ? "" : "off"}>
          <span className={`dot dot-${latest.get(agent.id) ?? (agent.enabled ? "idle" : "off")}`} />
          <span className="name">{agent.displayName}</span>
          <span className="tool">{agent.tool}</span>
          <span className="state">
            {agent.enabled ? (latest.get(agent.id) ?? "idle") : "disabled"}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The Info Panel: tokens and cost, per agent and per model. */
export function InfoPanel({ usage }: { usage: UsageTotals | null }): ReactElement {
  if (!usage) return <p className="empty">—</p>;

  const agents = Object.entries(usage.byAgent);
  const models = Object.entries(usage.byModel);
  if (agents.length === 0) return <p className="empty">No usage reported yet.</p>;

  return (
    <div className="info">
      <table>
        <tbody>
          {agents.map(([agentId, figures]) => (
            <tr key={agentId}>
              <th scope="row">{agentId}</th>
              <td>{tokens(figures)}</td>
              <td>{cost(figures)}</td>
            </tr>
          ))}
        </tbody>
        <tbody className="models">
          {models.map(([model, figures]) => (
            <tr key={model}>
              <th scope="row">{model}</th>
              <td>{tokens(figures)}</td>
              <td>{cost(figures)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">total</th>
            <td>{tokens(usage.total)}</td>
            <td>{cost(usage.total)}</td>
          </tr>
        </tfoot>
      </table>
      <p className="muted">Cached reads and writes are counted; they are most of the total.</p>
    </div>
  );
}

/** The secret channel: what an agent said to the user, bypassing the Operator. */
export function SecretChannel({ events }: { events: BusEvent[] }): ReactElement {
  const secret = events.filter((event) => event.channel === "secret");
  if (secret.length === 0) {
    return <p className="empty">Nothing here. Agents use this to reach you directly.</p>;
  }

  return (
    <ul className="secret-lane">
      {secret.map((event) => (
        <li key={event.id}>
          <span className="who">{event.agentId ?? "agent"}</span>
          <span className="said">
            {event.payload.type === "agent_message" || event.payload.type === "user_message"
              ? event.payload.text
              : // Maya's own observation, not the worker reaching out, so it
                // is worded as a report about the worker rather than as
                // something the worker said.
                event.payload.type === "worker_stopped_short"
                ? `stopped without changing anything, and asked nobody: ${event.payload.lastWords}`
                : event.type}
          </span>
          <time dateTime={event.createdAt}>{event.createdAt.slice(11, 16)}</time>
        </li>
      ))}
    </ul>
  );
}

function total(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0)
  );
}

function tokens(usage: TokenUsage): string {
  const count = total(usage);
  if (count < 1000) return `${count} t`;
  return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k t`;
}

function cost(usage: TokenUsage): string {
  return usage.costUsd === undefined ? "—" : `$${usage.costUsd.toFixed(2)}`;
}
