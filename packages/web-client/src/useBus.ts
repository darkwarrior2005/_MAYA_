import { useEffect, useRef, useState } from "react";
import type { BusEvent, ServerMessage, ServerSignal } from "@maya/shared-types";

export type Connection = "connecting" | "open" | "retrying";

export interface BusState {
  events: BusEvent[];
  connection: Connection;
  /** Increments on each signal, so a view can re-read what it derives. */
  signals: Record<ServerSignal, number>;
}

const RETRY_MS = 1000;

/**
 * The web client's half of the shared session: the same socket the CLI panes
 * read, resumed from the last event id this view rendered.
 *
 * Resuming by id rather than taking only live pushes is what keeps a dropped
 * socket from leaving a gap, and the id check is what keeps the overlap between
 * a replay and live delivery from showing an event twice.
 */
export function useBus(): BusState {
  const [events, setEvents] = useState<BusEvent[]>([]);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [signals, setSignals] = useState<Record<ServerSignal, number>>({ files_changed: 0 });

  const lastSeen = useRef(0);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let closed = false;

    const connect = (): void => {
      if (closed) return;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(
        `${scheme}://${window.location.host}/ws?since=${lastSeen.current}`,
      );

      socket.onopen = () => setConnection("open");

      socket.onmessage = (frame: MessageEvent<string>) => {
        let message: ServerMessage;
        try {
          message = JSON.parse(frame.data) as ServerMessage;
        } catch {
          return;
        }

        if (message.kind === "signal") {
          setSignals((current) => ({
            ...current,
            [message.signal]: (current[message.signal] ?? 0) + 1,
          }));
          return;
        }

        const event = message.event;
        if (event.id <= lastSeen.current) return;
        lastSeen.current = event.id;
        setEvents((current) => [...current, event]);
      };

      socket.onclose = () => {
        if (closed) return;
        setConnection("retrying");
        retry = window.setTimeout(connect, RETRY_MS);
      };
    };

    connect();

    return () => {
      closed = true;
      if (retry !== undefined) window.clearTimeout(retry);
      // Closing a socket mid-handshake throws in some browsers; the listeners
      // are detached first so a late event cannot touch unmounted state.
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        try {
          socket.close();
        } catch {
          /* already gone */
        }
      }
    };
  }, []);

  return { events, connection, signals };
}
