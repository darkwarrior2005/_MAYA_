import Database from "better-sqlite3";
import type { BusEvent, ChatChannel, EventId } from "@maya/shared-types";

export interface SinceOptions {
  channel?: ChatChannel;
  /** Newest `limit` events only. Omitted means everything since the id. */
  limit?: number;
}

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

  /** Shared handle for the other tables (tasks) that live in the same file. */
  get database(): Database.Database {
    return this.db;
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

  /**
   * Replay for a client reconnecting with the last event id it already has.
   *
   * `limit` caps how much comes back, newest-first then re-sorted, so a client
   * joining a long session gets the recent history rather than all of it: at
   * 5,000 events an uncapped replay was 1.1 MB on every page load.
   */
  since(lastSeenId: EventId, options: SinceOptions = {}): BusEvent[] {
    const { channel, limit } = options;
    if (limit !== undefined && limit > 0) {
      const rows = channel
        ? (this.db
            .prepare(
              `SELECT * FROM (SELECT * FROM events WHERE id > ? AND channel = ?
                 ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
            )
            .all(lastSeenId, channel, limit) as EventRow[])
        : (this.db
            .prepare(
              `SELECT * FROM (SELECT * FROM events WHERE id > ?
                 ORDER BY id DESC LIMIT ?) ORDER BY id ASC`,
            )
            .all(lastSeenId, limit) as EventRow[]);
      return rows.map(toBusEvent);
    }

    const rows = channel
      ? (this.db
          .prepare(`SELECT * FROM events WHERE id > ? AND channel = ? ORDER BY id ASC`)
          .all(lastSeenId, channel) as EventRow[])
      : (this.db
          .prepare(`SELECT * FROM events WHERE id > ? ORDER BY id ASC`)
          .all(lastSeenId) as EventRow[]);
    return rows.map(toBusEvent);
  }

  /** How many events are in the log, for a client deciding whether to ask for more. */
  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM events`).get() as { n: number };
    return row.n;
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
