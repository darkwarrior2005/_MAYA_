import { randomUUID } from "node:crypto";
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
/**
 * The marker, and what keeps it from firing on ordinary code.
 *
 * `@user` must be followed by a space or a colon and then something to say.
 * Without that, `@user.setter` — a normal Python property — would be read as
 * a message to the person, and so would a `@user` JSDoc tag. A line inside a
 * fenced code block never counts, whatever it says.
 */
export const SECRET_MARKER = /^\s*@user[:\s]\s*(?=\S)/i;

/**
 * The same shape, pointed at the Operator instead of the person.
 *
 * The brief has sub-agents asking the Operator for information, and a wrapped
 * CLI's only outbound channel is the text it prints — so this is a marker in
 * that text for the same reason `@user` is. Same guards: a separator and
 * something to say, never inside a fenced block, so `@operator` in a config
 * snippet an agent is quoting is not a question.
 */
export const OPERATOR_MARKER = /^\s*@operator[:\s]\s*(?=\S)/i;

const CODE_FENCE = /^\s*(```|~~~)/;

/*
 * Both briefings were rewritten after watching live models read the first
 * draft, which is the only way to tell whether prompt text works. Two agents
 * were given a task that cannot be completed honestly — delete whichever of
 * two files is unused, in a repository that nowhere says which — and both did
 * the right thing and stopped. Neither reached the person:
 *
 *  - Claude Code used `@operator`, twice, for a fact no Operator could
 *    possibly hold. The old Operator briefing ended "prefer this to `@user`",
 *    and that read as a blanket instruction rather than the "for things it
 *    can settle" it was qualified with.
 *  - Codex used no marker at all. It asked in ordinary prose, which reaches
 *    nobody, and the run was then recorded as a clean success with a question
 *    sitting in its transcript.
 *
 * So the rewrite does three things the first draft did not: it says which
 * channel by *who can know* rather than by preference, it shows the literal
 * line, and it says plainly that an unmarked question is not delivered. That
 * last one is the important one — a model that believes it has asked has
 * stopped working for a reason nobody will ever see.
 */
export const SECRET_CHANNEL_BRIEFING = `${[
  "If what you need can only come from the human — a fact that is nowhere in the",
  "repository and that no amount of reading will settle, or a choice that is",
  "theirs to make — begin a line with `@user` and ask it plainly:",
].join(" ")}

    @user Should the importer skip rows with no email address, or stop?

${[
  "That line reaches them. Nothing else does: a question written in ordinary",
  "prose is delivered to nobody, and a run that ends with one is recorded as",
  "finished rather than as waiting for an answer.",
].join(" ")}`;

export const OPERATOR_CHANNEL_BRIEFING = [
  "If what you need is about the work rather than about the world — the wider",
  "task, a decision about scope, what another worker has already done — begin a",
  "line with `@operator` instead. It answers, and the answer comes back to you.",
  "Which of the two to use is decided by who could know: the Operator knows this",
  "session and this task, and cannot know what lives only in the person's head.",
  "Ask the Operator where it could reasonably know, and the person where it could",
  "not. Either is better than guessing, and both are far better than stopping",
  "with the question unasked.",
].join(" ");

export interface SplitText {
  /** What stays in the Operator's transcript. */
  main: string;
  /** Lines addressed to the user, marker removed. */
  secret: string[];
  /** Questions put to the Operator, marker removed. */
  questions: string[];
}

export function splitSecretLines(text: string): SplitText {
  const main: string[] = [];
  const secret: string[] = [];
  const questions: string[] = [];
  let insideCode = false;

  for (const line of text.split("\n")) {
    if (CODE_FENCE.test(line)) {
      insideCode = !insideCode;
      main.push(line);
      continue;
    }

    // Code an agent is showing the person is not a message to the person,
    // however it begins.
    const secretMatch = insideCode ? null : SECRET_MARKER.exec(line);
    if (secretMatch) {
      const body = line.slice(secretMatch[0].length).trim();
      if (body) secret.push(body);
      continue;
    }

    const operatorMatch = insideCode ? null : OPERATOR_MARKER.exec(line);
    if (operatorMatch) {
      const body = line.slice(operatorMatch[0].length).trim();
      if (body) questions.push(body);
      continue;
    }
    main.push(line);
  }

  return { main: main.join("\n").trim(), secret, questions };
}

/**
 * The one place agent events reach the bus, so the secret channel cannot be
 * forgotten by a caller. Everything except text passes through untouched.
 *
 * Returns what belongs in the agent's recorded transcript: the main part
 * only. Callers used to push `event.text` themselves and so wrote the user's
 * private line into `.maya/agents/<id>/latest.md` alongside everything else —
 * a line the channel had just promised would not go through the Operator sat
 * in a file the Operator could read. Taking the transcript text from here
 * means a caller cannot record the unsplit version by accident.
 */
export interface PublishedAgentEvent {
  transcript: string | null;
  /**
   * Questions this event put to the Operator, with the id each was published
   * under. The caller collects these and has the Operator answer them; the
   * ids are what tie an answer back to its question in the log.
   */
  questions: Array<{ questionId: string; question: string }>;
}

export function publishAgentEvent(
  bus: EventBus,
  agentId: AgentId,
  event: AgentEvent,
): PublishedAgentEvent {
  if (event.type !== "text") {
    bus.publish("main", agentId, event.type, event);
    return {
      transcript: event.type === "tool_call" ? `[tool] ${event.toolName}` : null,
      questions: [],
    };
  }

  const { main, secret, questions } = splitSecretLines(event.text);

  for (const line of secret) {
    bus.publish("secret", agentId, "agent_message", {
      type: "agent_message",
      agentId,
      text: line,
    });
  }

  // A question to the Operator stays on the main channel: unlike a `@user`
  // line, it is the Operator's business and belongs in its transcript.
  const asked = questions.map((question) => {
    const questionId = randomUUID().slice(0, 8);
    bus.publish("main", agentId, "agent_question", {
      type: "agent_question",
      questionId,
      agentId,
      question,
    });
    return { questionId, question };
  });

  // A message that was entirely for the user leaves nothing for the main
  // transcript, and publishing an empty line there would be noise.
  if (main) bus.publish("main", agentId, "text", { ...event, text: main });
  return { transcript: main || null, questions: asked };
}
