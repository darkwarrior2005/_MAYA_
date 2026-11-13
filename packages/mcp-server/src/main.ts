#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type {
  BusEvent,
  ConflictOption,
  GitGraph,
  RepoTree,
  SessionInfo,
  TaskSpec,
  UsageTotals,
} from "@maya/shared-types";
import { MayaClient } from "./maya-client.js";

/**
 * Maya as a tool other agents can use.
 *
 * An agent working inside a Maya-managed repository can see what the session
 * is doing, say something in its chat, reach the human directly, and answer
 * the Operator's merge question — the same four things a person can do from
 * the pane view or the browser, through the same daemon API, so nothing here
 * is a second way into the state.
 *
 * It deliberately offers no way to queue work. Writing a row into the task
 * queue would show up in the To-Do panel and then never run, because the
 * Operator executes the list it was given at start. A tool that looks like it
 * assigns work but does not is worse than no tool.
 */

const DEFAULT_EVENT_LIMIT = 40;

function textResult(text: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text }] };
}

function errorResult(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

const projectArg = {
  project: z
    .string()
    .optional()
    .describe(
      "The Maya project directory. Defaults to MAYA_PROJECT, then the working directory.",
    ),
};

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "maya", version: "1.0.0" },
    {
      instructions: [
        "Maya runs several AI coding CLIs under one Operator agent against a git",
        "repository. These tools act on a running Maya session.",
        "",
        "Call maya_session first: it says whether a session is running and what it",
        "is working on. Everything else needs one.",
        "",
        "maya_say posts to the shared chat, which the person sees in the terminal",
        "panes and the web interface. maya_tell_user reaches them directly on the",
        "secret channel, for something that cannot wait and should not be buried",
        "in the Operator's transcript — use it sparingly.",
      ].join("\n"),
    },
  );

  server.registerTool(
    "maya_session",
    {
      title: "Maya session status",
      description:
        "What the running Maya session is: repository, branch, whether the tree is " +
        "clean, the configured agents, and how many events the log holds. Says so " +
        "plainly when no session is running.",
      inputSchema: projectArg,
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => {
      try {
        const client = MayaClient.forProject(project);
        const session = await client.get<SessionInfo>("/api/session");
        const workers = session.workers
          .map((w) => `${w.enabled ? "on " : "off"} ${w.id} (${w.tool})`)
          .join("\n  ");
        return textResult(
          [
            `repository: ${session.repoRoot}`,
            `branch:     ${session.branch}`,
            `tree:       ${session.clean ? "clean" : `${session.changedFiles ?? 0} changed`}`,
            `events:     ${session.latestEventId}`,
            `operator:   ${session.operator.displayName} (${session.operator.tool})`,
            `workers:`,
            `  ${workers}`,
          ].join("\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "maya_recent_activity",
    {
      title: "Recent Maya activity",
      description:
        "The most recent entries from the session's shared log: what each agent " +
        "said and did, task assignments, merges, and questions. Use it to find out " +
        "what has already been tried before doing anything.",
      inputSchema: {
        ...projectArg,
        limit: z.number().int().min(1).max(200).optional().describe("How many entries. Default 40."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, limit }) => {
      try {
        const client = MayaClient.forProject(project);
        const page = await client.get<{ events: BusEvent[]; total: number }>(
          `/api/events?since=0&limit=${limit ?? DEFAULT_EVENT_LIMIT}`,
        );
        if (page.events.length === 0) return textResult("Nothing has happened yet.");
        const lines = page.events.map(describeEvent).filter((line): line is string => line !== null);
        return textResult(
          `${lines.length} of ${page.total} entries:\n\n${lines.join("\n")}`,
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "maya_tasks",
    {
      title: "Maya task list",
      description:
        "Every task in the session and where it stands: pending, running, merged, " +
        "blocked or failed, and which agent holds it.",
      inputSchema: projectArg,
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => {
      try {
        const tasks = await MayaClient.forProject(project).get<TaskSpec[]>("/api/tasks");
        if (tasks.length === 0) return textResult("No tasks.");
        return textResult(
          tasks
            .map((t) => `${t.state.padEnd(10)} ${t.assignedTo ?? "unassigned"}  ${t.summary}`)
            .join("\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "maya_git_tree",
    {
      title: "Maya git tree",
      description:
        "The session's commit graph as its Git Tree panel shows it, including the " +
        "task branches agents are working on.",
      inputSchema: {
        ...projectArg,
        limit: z.number().int().min(1).max(200).optional().describe("How many commits. Default 20."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ project, limit }) => {
      try {
        const graph = await MayaClient.forProject(project).get<GitGraph>(
          `/api/graph?limit=${limit ?? 20}`,
        );
        if (graph.nodes.length === 0) return textResult("No commits yet.");
        const lines = graph.nodes.map((node) => {
          const refs = node.refs.length > 0 ? `  (${node.refs.join(", ")})` : "";
          return `${"  ".repeat(node.lane)}* ${node.sha.slice(0, 7)} ${node.subject}${refs}`;
        });
        return textResult(`on ${graph.currentBranch ?? "a detached HEAD"}:\n\n${lines.join("\n")}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "maya_files",
    {
      title: "Maya repository tree",
      description:
        "The files in the managed repository, as git sees them — tracked plus " +
        "untracked that is not ignored.",
      inputSchema: projectArg,
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => {
      try {
        const tree = await MayaClient.forProject(project).get<RepoTree>("/api/files");
        const paths: string[] = [];
        const walk = (node: RepoTree["root"]): void => {
          if (node.type === "file" && node.path) paths.push(node.path);
          for (const child of node.children ?? []) walk(child);
        };
        walk(tree.root);
        return textResult(`${tree.fileCount} files:\n\n${paths.join("\n")}`);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "maya_usage",
    {
      title: "Maya token and cost usage",
      description:
        "What this session has spent, per agent and per model. Cached reads and " +
        "writes are included; they are most of the real total.",
      inputSchema: projectArg,
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => {
      try {
        const usage = await MayaClient.forProject(project).get<UsageTotals>("/api/usage");
        const rows = Object.entries(usage.byAgent).map(
          ([agent, figures]) =>
            `${agent.padEnd(18)} ${tokens(figures)} tokens${
              figures.costUsd === undefined ? "" : `  $${figures.costUsd.toFixed(2)}`
            }`,
        );
        if (rows.length === 0) return textResult("Nothing reported yet.");
        return textResult(
          [
            ...rows,
            "",
            `total              ${tokens(usage.total)} tokens${
              usage.total.costUsd === undefined ? "" : `  $${usage.total.costUsd.toFixed(2)}`
            }`,
          ].join("\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "maya_say",
    {
      title: "Post to the Maya session chat",
      description:
        "Says something in the session's shared chat. It appears live in the " +
        "terminal panes and the web interface, and is kept in the session log. Use " +
        "it to report what you are doing or what you found.",
      inputSchema: {
        ...projectArg,
        message: z.string().min(1).describe("What to say. Plain text."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ project, message }) => {
      try {
        const client = MayaClient.forProject(project);
        await client.post<{ id: number }>("/api/message", { text: message });
        return textResult("Posted to the session chat.");
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "maya_tell_user",
    {
      title: "Reach the person directly",
      description:
        "Sends a message on the secret channel, which reaches the person without " +
        "going through the Operator's transcript. For a decision only they can " +
        "make, or a detail without which the work would be guesswork. Not for " +
        "progress reports — use maya_say for those.",
      inputSchema: {
        ...projectArg,
        message: z.string().min(1).describe("What to tell them, in one or two sentences."),
        from: z
          .string()
          .optional()
          .describe("Who is asking. Defaults to \"external-agent\"."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ project, message, from }) => {
      try {
        const client = MayaClient.forProject(project);
        // Named explicitly rather than by the `@user` marker: that marker is
        // read out of an agent's own text stream, and this is a direct post.
        await client.post<{ id: number }>("/api/message", {
          text: message,
          channel: "secret",
          from: from ?? "external-agent",
        });
        return textResult("Sent on the secret channel. They see it in their own panel.");
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "maya_pending_question",
    {
      title: "The Operator's open question",
      description:
        "Whether the Operator is waiting on a decision — usually a merge it cannot " +
        "make on its own — and what the options are.",
      inputSchema: projectArg,
      annotations: { readOnlyHint: true },
    },
    async ({ project }) => {
      try {
        const state = await MayaClient.forProject(project).get<{
          answerable: boolean;
          pending: { question: string; options: ConflictOption[] } | null;
        }>("/api/conflict");
        if (!state.pending) return textResult("Nothing is waiting on a decision.");
        const options = state.pending.options
          .map((option, index) => `  ${index + 1}. ${option.label}`)
          .join("\n");
        return textResult(
          [
            state.pending.question,
            "",
            options,
            "",
            state.answerable
              ? "Answer with maya_answer_question, giving the option number or your own words."
              : "This session answers in its own terminal; it cannot be answered from here.",
          ].join("\n"),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "maya_answer_question",
    {
      title: "Answer the Operator's question",
      description:
        "Answers the open question: an option number, or your own words. This " +
        "decides what happens to a branch, so check maya_pending_question first " +
        "and do not answer on the person's behalf unless they asked you to.",
      inputSchema: {
        ...projectArg,
        answer: z
          .string()
          .min(1)
          .describe("An option number such as \"2\", or an instruction in your own words."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ project, answer }) => {
      try {
        await MayaClient.forProject(project).post<{ ok: true }>("/api/conflict", { answer });
        return textResult("Answered. The Operator has it.");
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

function tokens(usage: UsageTotals["total"]): string {
  const total =
    usage.inputTokens +
    usage.outputTokens +
    (usage.cacheReadTokens ?? 0) +
    (usage.cacheWriteTokens ?? 0);
  return total < 1000 ? String(total) : `${(total / 1000).toFixed(1)}k`;
}

/** One line per event, or null for the ones with nothing to show. */
function describeEvent(event: BusEvent): string | null {
  const at = event.createdAt.slice(11, 19);
  const who = event.agentId ?? "maya";
  const payload = event.payload;
  const line = (text: string): string => `${at}  ${who.padEnd(16)} ${text}`;

  switch (payload.type) {
    case "text":
      return payload.text.trim() ? line(payload.text.trim()) : null;
    case "tool_call":
      return line(`used ${payload.toolName}`);
    case "status":
      return line(`${payload.status}${payload.detail ? ` — ${payload.detail}` : ""}`);
    case "error":
      return line(`${payload.fatal ? "error" : "warning"}: ${payload.message}`);
    case "done":
      return line(payload.ok ? "finished" : "finished with errors");
    case "user_message":
      return line(`(person) ${payload.text}`);
    case "agent_message":
      return line(`${event.channel === "secret" ? "(direct) " : ""}${payload.text}`);
    case "task_assigned":
      return line(`assigned ${payload.agentId}: ${payload.summary} on ${payload.branch}`);
    case "task_completed":
      return line(`${payload.agentId} finished ${payload.ok ? "cleanly" : "with errors"}`);
    case "merge_result":
      return line(
        payload.merged
          ? `merged ${payload.branch}`
          : `merge blocked on ${payload.branch} (${payload.conflicts.join(", ") || "unclean tree"})`,
      );
    case "conflict_prompt":
      return line(`asks: ${payload.question}`);
    case "conflict_resolved":
      return line(`decided: ${payload.chosen}`);
    default:
      return null;
  }
}

const server = buildServer();
await server.connect(new StdioServerTransport());
