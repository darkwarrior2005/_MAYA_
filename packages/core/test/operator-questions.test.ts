// A2: a worker asking the Operator something, end to end.
//
// Before this the only agent-initiated channel was `@user`, so a worker that
// needed to know something could only interrupt the human — the one thing the
// Operator exists to prevent. The end-to-end tests use a real git repository
// and a real event log, because what breaks here is the seams: the marker, the
// routing, and whether the answer actually gets back to the worker.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent, BusEvent } from "@maya/shared-types";
import type {
  AdapterHealth,
  AgentAdapter,
  AgentHandle,
  AgentRunOptions,
  AgentRunResult,
} from "../src/adapters/adapter.js";
import { AdapterRegistry } from "../src/adapters/registry.js";
import { EventBus } from "../src/bus/event-bus.js";
import { EventStore } from "../src/bus/event-store.js";
import type { WorkerProfile } from "../src/config/maya-config.js";
import { RepoManager } from "../src/git/repo-manager.js";
import { HoldOnConflictResolver } from "../src/orchestrator/conflict-resolver.js";
import { Operator } from "../src/orchestrator/operator.js";
import {
  OPERATOR_CHANNEL_BRIEFING,
  OPERATOR_MARKER,
  publishAgentEvent,
  splitSecretLines,
} from "../src/orchestrator/secret-channel.js";
import { parseAnswer } from "../src/orchestrator/question-answerer.js";
import { TaskQueue } from "../src/orchestrator/task-queue.js";
import { withAgentChannels } from "../src/orchestrator/task-runner.js";
import { makeTempRepo, onCleanup, runCleanups, safeRemove } from "./helpers.js";

afterEach(runCleanups);

function makeBus(dir: string): { bus: EventBus; seen: BusEvent[] } {
  const store = new EventStore(join(dir, "state.db"));
  onCleanup(() => store.close());
  const bus = new EventBus(store);
  const seen: BusEvent[] = [];
  bus.subscribe((event) => seen.push(event));
  return { bus, seen };
}

describe("the @operator marker", () => {
  it("lifts a question out and leaves the rest alone", () => {
    const split = splitSecretLines(
      "Started on the importer.\n@operator does the CSV have a header row?\nCarrying on.",
    );
    expect(split.questions).toEqual(["does the CSV have a header row?"]);
    expect(split.main).toBe("Started on the importer.\nCarrying on.");
    expect(split.secret).toEqual([]);
  });

  it("accepts the spellings an agent will actually produce", () => {
    expect(splitSecretLines("@operator: with a colon").questions).toEqual(["with a colon"]);
    expect(splitSecretLines("  @Operator  spaced and capitalised").questions).toEqual([
      "spaced and capitalised",
    ]);
    // Nothing to ask is not a question.
    expect(splitSecretLines("@operator").questions).toEqual([]);
  });

  it("does not fire on ordinary text containing the word", () => {
    const text = "the @operator decorator is required\nmail ops@operator.example.com";
    expect(splitSecretLines(text).questions).toEqual([]);
    expect(splitSecretLines(text).main).toBe(text);
  });

  it("ignores a marker inside a fence, which is code being shown", () => {
    const text = ["Here is the config:", "```", "@operator: root", "```", "done"].join("\n");
    expect(splitSecretLines(text).questions).toEqual([]);
    expect(splitSecretLines(text).main).toBe(text);
  });

  it("keeps the two channels apart in one message", () => {
    const split = splitSecretLines(
      [
        "@user is this the live database?",
        "@operator which table holds the totals?",
        "working",
      ].join("\n"),
    );
    expect(split.secret).toEqual(["is this the live database?"]);
    expect(split.questions).toEqual(["which table holds the totals?"]);
    expect(split.main).toBe("working");
  });

  it("is anchored at the start of the line, like the user marker", () => {
    expect(OPERATOR_MARKER.test("@operator ask")).toBe(true);
    expect(OPERATOR_MARKER.test("please @operator ask")).toBe(false);
  });
});

describe("publishing a question", () => {
  it("puts it on main, where it is the Operator's business", async () => {
    const dir = await makeTempRepo();
    onCleanup(() => safeRemove(dir));
    const { bus, seen } = makeBus(dir);

    const published = publishAgentEvent(bus, "worker-a", {
      type: "text",
      agentId: "worker-a",
      text: "Wrote the importer.\n@operator which delimiter should I assume?",
    });

    const questions = seen.filter((event) => event.type === "agent_question");
    expect(questions).toHaveLength(1);
    expect(questions[0]?.channel).toBe("main");
    expect((questions[0]?.payload as { question: string }).question).toBe(
      "which delimiter should I assume?",
    );

    // Reported to the caller with its id, so an answer can be tied to it.
    expect(published.questions).toHaveLength(1);
    expect((questions[0]?.payload as { questionId: string }).questionId).toBe(
      published.questions[0]?.questionId,
    );

    // Unlike a `@user` line, the rest of the message still reaches main.
    const text = seen.filter((event) => event.type === "text");
    expect((text[0]?.payload as { text: string }).text).toBe("Wrote the importer.");
  });

  it("never sends a question to the secret channel", async () => {
    const dir = await makeTempRepo();
    onCleanup(() => safeRemove(dir));
    const { bus, seen } = makeBus(dir);
    publishAgentEvent(bus, "worker-a", {
      type: "text",
      agentId: "worker-a",
      text: "@operator what is the base branch?",
    });
    expect(seen.every((event) => event.channel !== "secret")).toBe(true);
  });
});

describe("the briefing", () => {
  it("tells the agent both markers, since it cannot use one it never heard of", () => {
    const prompt = withAgentChannels("Add a README.");
    expect(prompt).toContain("Add a README.");
    expect(prompt).toContain(OPERATOR_CHANNEL_BRIEFING);
    expect(prompt).toContain("@operator");
    expect(prompt).toContain("@user");
  });
});

describe("parseAnswer", () => {
  it("takes a labelled answer", () => {
    expect(parseAnswer("ANSWER: assume a header row")).toBe("assume a header row");
  });

  it("takes a plain one, because a model will not always use the label", () => {
    expect(parseAnswer("Assume a header row.")).toBe("Assume a header row.");
  });

  it("refuses an echoed template or an empty reply rather than passing it on", () => {
    expect(parseAnswer("ANSWER: <your answer>")).toBeNull();
    expect(parseAnswer("ANSWER:")).toBeNull();
    expect(parseAnswer("   ")).toBeNull();
  });
});

/**
 * A worker that asks one question, then does the work on its second turn.
 *
 * `resumable: true` is the point: the answer can only reach it by resuming the
 * session, because a wrapped CLI takes no input mid-run.
 */
class AskingWorker implements AgentAdapter {
  readonly id = "claude-code" as const;
  readonly displayName = "Asking";
  readonly capabilities = { streaming: true, structuredOutput: true, resumable: true };
  readonly prompts: string[] = [];
  readonly resumedFrom: Array<string | undefined> = [];

  constructor(private readonly resumable = true) {
    this.capabilities = { streaming: true, structuredOutput: true, resumable };
  }

  async check(): Promise<AdapterHealth> {
    return { installed: true, authenticated: true, verified: true };
  }

  async start(options: AgentRunOptions): Promise<AgentHandle> {
    this.prompts.push(options.prompt);
    this.resumedFrom.push(options.resumeSessionId);
    const turn = this.prompts.length;
    const listeners = new Set<(event: AgentEvent) => void>();

    return {
      agentId: options.agentId,
      onEvent(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      waitForCompletion: async (): Promise<AgentRunResult> => {
        const say = (text: string): void => {
          for (const listener of listeners) {
            listener({ type: "text", agentId: options.agentId, text });
          }
        };

        if (turn === 1) {
          say("@operator should the README mention the licence?");
          return { ok: true, stalled: false, sessionId: "session-1" };
        }

        const { writeFileSync } = await import("node:fs");
        writeFileSync(join(options.cwd, "README.md"), "docs\n", "utf8");
        say("done");
        return { ok: true, stalled: false, sessionId: "session-1" };
      },
      interrupt: async () => {},
      kill: async () => {},
    };
  }
}

/**
 * The Operator's own adapter. A different tool id so the registry can hold it
 * alongside the worker, exactly as the planning tests do.
 */
function answeringOperator(asked: string[]): AgentAdapter {
  return {
    id: "copilot-cli",
    displayName: "Operator",
    capabilities: { streaming: true, structuredOutput: false, resumable: false },
    async check(): Promise<AdapterHealth> {
      return { installed: true, authenticated: true };
    },
    async start(options: AgentRunOptions): Promise<AgentHandle> {
      asked.push(options.prompt);
      const listeners = new Set<(event: AgentEvent) => void>();
      return {
        agentId: options.agentId,
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        waitForCompletion: async () => {
          // Planning, describing and answering all reach this adapter; only
          // the answering prompt is being exercised, so the others fall back.
          const answer = options.prompt.includes("has asked you this")
            ? "ANSWER: yes, name the licence in one line"
            : "nothing useful";
          for (const listener of listeners) {
            listener({ type: "text", agentId: options.agentId, text: answer });
          }
          return { ok: true, stalled: false };
        },
        interrupt: async () => {},
        kill: async () => {},
      };
    },
  };
}

function profile(id: string, tool: WorkerProfile["tool"] = "claude-code"): WorkerProfile {
  return { id, tool, displayName: id, stallTimeoutSec: 5, enabled: true };
}

async function setup(worker: AgentAdapter, operatorAdapter?: AgentAdapter) {
  const dir = await makeTempRepo();
  const repo = new RepoManager(dir);
  await repo.openOrInit();
  const store = new EventStore(repo.paths.dbFile);
  onCleanup(() => store.close());
  onCleanup(() => safeRemove(dir));
  const bus = new EventBus(store);
  const seen: BusEvent[] = [];
  bus.subscribe((event) => seen.push(event));

  const registry = new AdapterRegistry().register(worker);
  if (operatorAdapter) registry.register(operatorAdapter);

  const operator = new Operator({
    repo,
    registry,
    bus,
    queue: new TaskQueue(store.database),
    conflicts: new HoldOnConflictResolver(bus),
    workers: [profile("worker-one")],
    ...(operatorAdapter ? { operator: profile("operator", operatorAdapter.id) } : {}),
  });

  return { dir, operator, seen };
}

describe("the Operator answering a worker", () => {
  it("answers, publishes the answer, and resumes the worker with it", async () => {
    const worker = new AskingWorker();
    const prompts: string[] = [];
    const { dir, operator, seen } = await setup(worker, answeringOperator(prompts));

    await operator.run(["write the README"]);

    // The question reached the log.
    const question = seen.find((event) => event.type === "agent_question");
    expect(question).toBeDefined();
    expect((question?.payload as { question: string }).question).toBe(
      "should the README mention the licence?",
    );

    // The Operator was actually asked, with the worker's task as context.
    const answering = prompts.find((prompt) => prompt.includes("has asked you this"));
    expect(answering).toBeDefined();
    expect(answering).toContain("should the README mention the licence?");
    expect(answering).toContain("write the README");

    // And the answer reached the log, tied to its question.
    const answer = seen.find((event) => event.type === "operator_answer");
    expect(answer).toBeDefined();
    expect((answer?.payload as { answered: boolean }).answered).toBe(true);
    expect((answer?.payload as { answer: string }).answer).toBe(
      "yes, name the licence in one line",
    );
    expect((answer?.payload as { questionId: string }).questionId).toBe(
      (question?.payload as { questionId: string }).questionId,
    );

    // The worker got a second turn, resumed from its session, carrying the
    // answer — which is the only way an answer can reach a one-shot CLI.
    expect(worker.prompts).toHaveLength(2);
    expect(worker.resumedFrom[1]).toBe("session-1");
    expect(worker.prompts[1]).toContain("yes, name the licence in one line");

    // And it then did the work, which landed on main.
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("docs\n");
  });

  it("says plainly that nobody could answer when no Operator is configured", async () => {
    const worker = new AskingWorker();
    const { operator, seen } = await setup(worker);

    await operator.run(["write the README"]);

    const answer = seen.find((event) => event.type === "operator_answer");
    expect(answer).toBeDefined();
    expect((answer?.payload as { answered: boolean }).answered).toBe(false);
    expect((answer?.payload as { answer: string }).answer).toContain("Use your judgement");

    // No resume: there was no answer worth a second paid turn.
    expect(worker.prompts).toHaveLength(1);
  });

  it("does not resume a tool that cannot resume, but still logs the answer", async () => {
    const worker = new AskingWorker(false);
    const prompts: string[] = [];
    const { operator, seen } = await setup(worker, answeringOperator(prompts));

    await operator.run(["write the README"]);

    const answer = seen.find((event) => event.type === "operator_answer");
    expect((answer?.payload as { answered: boolean }).answered).toBe(true);
    // One turn only: there is no session to resume, so the answer is in the
    // log for the person rather than delivered to the agent.
    expect(worker.prompts).toHaveLength(1);
  });

  it("asks once and stops, so a question loop cannot spend without a bound", async () => {
    // Asks on every turn it is given.
    class AlwaysAsking extends AskingWorker {
      override async start(options: AgentRunOptions): Promise<AgentHandle> {
        this.prompts.push(options.prompt);
        this.resumedFrom.push(options.resumeSessionId);
        const listeners = new Set<(event: AgentEvent) => void>();
        return {
          agentId: options.agentId,
          onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          waitForCompletion: async () => {
            for (const listener of listeners) {
              listener({
                type: "text",
                agentId: options.agentId,
                text: "@operator and what about the changelog?",
              });
            }
            return { ok: true, stalled: false, sessionId: "session-1" };
          },
          interrupt: async () => {},
          kill: async () => {},
        };
      }
    }

    const worker = new AlwaysAsking();
    const prompts: string[] = [];
    const { operator } = await setup(worker, answeringOperator(prompts));

    await operator.run(["write the README"]);

    // Two turns: the original and one resume. Not three, not forever.
    expect(worker.prompts).toHaveLength(2);
  });
});
