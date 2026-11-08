import { EventEmitter } from "node:events";
import type { BusEvent, ChatChannel, EventId } from "@maya/shared-types";
import type { EventStore } from "./event-store.js";

type Listener = (event: BusEvent) => void;

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

  /** Catch a client up from where it left off, then keep it live. */
  replayAndSubscribe(lastSeenId: EventId, listener: Listener): () => void {
    for (const event of this.store.since(lastSeenId)) listener(event);
    return this.subscribe(listener);
  }
}
