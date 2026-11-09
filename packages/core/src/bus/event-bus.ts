import { EventEmitter } from "node:events";
import type { BusEvent, ChatChannel, EventId } from "@maya/shared-types";
import type { EventStore } from "./event-store.js";

type Listener = (event: BusEvent) => void;

/** How much history a newly connected view is given up front. */
export const REPLAY_LIMIT = 500;

/**
 * Single publish point for everything agents say or do. Every subscriber
 * (CLI panes, web clients) reads the same stream, which is what keeps the two
 * interfaces showing one session.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly store: EventStore) {
    this.emitter.setMaxListeners(0);
  }

  publish(
    channel: ChatChannel,
    agentId: string | null,
    type: BusEvent["type"],
    payload: BusEvent["payload"],
  ): BusEvent {
    const event = this.store.append({ channel, agentId, type, payload });
    this.emitter.emit("event", event);
    return event;
  }

  subscribe(listener: Listener): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  /**
   * Catch a client up from where it left off, then keep it live.
   *
   * The catch-up is capped. A client that has seen nothing of a long session
   * does not need all of it to be useful, and sending all of it cost 1.1 MB
   * at 5,000 events on every page load. Older history is still there to be
   * asked for over `/api/events`.
   */
  replayAndSubscribe(lastSeenId: EventId, listener: Listener, limit = REPLAY_LIMIT): () => void {
    for (const event of this.store.since(lastSeenId, { limit })) listener(event);
    return this.subscribe(listener);
  }
}
