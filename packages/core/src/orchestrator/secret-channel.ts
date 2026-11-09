import type { AgentEvent, AgentId } from "@maya/shared-types";
import type { EventBus } from "../bus/event-bus.js";

/**
 * How an agent reaches the user directly.
 *
 * A wrapped CLI has exactly one way to say anything: the text it prints. There
 * is no side channel to give it, so the channel is a marker in that text. A
 * line beginning with `@user` is lifted out of the main chat and published on
 * the secret channel, where it reaches the user without passing through the
 * Operator's transcript.
 *
 * The marker has to be told to the agent for any of this to happen, which is
 * what `SECRET_CHANNEL_BRIEFING` is for.
 */
export const SECRET_MARKER = /^\s*@user\b:?\s?/i;

export const SECRET_CHANNEL_BRIEFING = [
  "If you need something from the human directly — a decision only they can make,",
  "or a detail without which your work would be guesswork — begin a line with",
  "`@user` and say it plainly. That line reaches them directly rather than going",
  "through the Operator. Use it when going through the Operator would lose or",
  "delay what you need, not for ordinary progress reporting.",
].join(" ");

export interface SplitText {
  /** What stays in the Operator's transcript. */
  main: string;
  /** Lines addressed to the user, marker removed. */
  secret: string[];
}

export function splitSecretLines(text: string): SplitText {
  const main: string[] = [];
  const secret: string[] = [];

  for (const line of text.split("\n")) {
    const match = SECRET_MARKER.exec(line);
    if (match) {
      const body = line.slice(match[0].length).trim();
      if (body) secret.push(body);
      continue;
    }
    main.push(line);
  }

  return { main: main.join("\n").trim(), secret };
}

/**
 * The one place agent events reach the bus, so the secret channel cannot be
 * forgotten by a caller. Everything except text passes through untouched.
 */
export function publishAgentEvent(bus: EventBus, agentId: AgentId, event: AgentEvent): void {
  if (event.type !== "text") {
    bus.publish("main", agentId, event.type, event);
    return;
  }

  const { main, secret } = splitSecretLines(event.text);

  for (const line of secret) {
    bus.publish("secret", agentId, "agent_message", {
      type: "agent_message",
      agentId,
      text: line,
    });
  }

  // A message that was entirely for the user leaves nothing for the main
  // transcript, and publishing an empty line there would be noise.
  if (main) bus.publish("main", agentId, "text", { ...event, text: main });
}
