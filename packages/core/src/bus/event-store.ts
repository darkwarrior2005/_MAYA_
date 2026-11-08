import Database from "better-sqlite3";
import type { BusEvent, ChatChannel, EventId } from "@maya/shared-types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  channel     TEXT NOT NULL,
  agent_id    TEXT,
  type        TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_channel ON events(channel, id);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  summary     TEXT NOT NULL,
  instruction TEXT NOT NULL,
  assigned_to TEXT,
  branch      TEXT,
  state       TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
`;

type EventRow = {
  id: number;
  channel: string;
  agent_id: string | null;
  type: string;
  payload_json: string;
  created_at: string;
};

/**
 * Durable append-only event log. WAL mode is required, not optional: multiple
 * agent processes publish concurrently and the default rollback journal locks
 * the database under that load.
 */
export class EventStore {
  private readonly db: Database.Database;

  constructor(dbFile: string) {
    this.db = new Database(dbFile);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  get journalMode(): string {
    const rows = this.db.pragma("journal_mode") as Array<{ journal_mode: string }>;
    return rows[0]?.journal_mode ?? "unknown";
  }

  append(event: Omit<BusEvent, "id" | "createdAt">): BusEvent {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(
        `INSERT INTO events (channel, agent_id, type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        event.channel,
        event.agentId,
        event.type,
        JSON.stringify(event.payload),
        createdAt,
      );
    return { ...event, id: Number(result.lastInsertRowid), createdAt };
  }

  /** Replay for a client reconnecting with the last event id it already has. */
  since(lastSeenId: EventId, channel?: ChatChannel): BusEvent[] {
    const rows = channel
      ? (this.db
          .prepare(`SELECT * FROM events WHERE id > ? AND channel = ? ORDER BY id ASC`)
          .all(lastSeenId, channel) as EventRow[])
      : (this.db
          .prepare(`SELECT * FROM events WHERE id > ? ORDER BY id ASC`)
          .all(lastSeenId) as EventRow[]);
    return rows.map(toBusEvent);
  }

  latestId(): EventId {
    const row = this.db.prepare(`SELECT MAX(id) AS maxId FROM events`).get() as {
      maxId: number | null;
    };
    return row.maxId ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

function toBusEvent(row: EventRow): BusEvent {
  return {
    id: row.id,
    channel: row.channel as BusEvent["channel"],
    agentId: row.agent_id,
    type: row.type as BusEvent["type"],
    payload: JSON.parse(row.payload_json) as BusEvent["payload"],
    createdAt: row.created_at,
  };
}
