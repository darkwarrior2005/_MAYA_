import { resolve } from "node:path";
import type { Command } from "commander";
import {
  ClaudeCodeAdapter,
  EventBus,
  EventStore,
  RepoManager,
  TaskRunner,
  loadConfig,
} from "@maya/core";
import type { AgentDescriptor, BusEvent } from "@maya/shared-types";

interface RunOptions {
  dir: string;
  hold?: boolean;
  timeout?: string;
}

export function registerRun(program: Command): void {
  program
    .command("run")
    .description("Run one task through a single agent on its own branch, then merge")
    .argument("<task...>", "what the agent should do")
    .option("-d, --dir <dir>", "project directory", ".")
    .option("--hold", "leave the work on its branch instead of merging", false)
    .option("--timeout <seconds>", "stall watchdog budget")
    .action(async (taskWords: string[], options: RunOptions) => {
      const repoRoot = resolve(options.dir);
      const repo = new RepoManager(repoRoot);
      await repo.openOrInit();

      const config = loadConfig(repo.paths);
      const store = new EventStore(repo.paths.dbFile);
      const bus = new EventBus(store);

      bus.subscribe(printEvent);

      const profile = config.workers[0] ?? config.operator;
      const agent: AgentDescriptor = {
        id: profile.id,
        role: "worker",
        tool: profile.tool,
        displayName: profile.displayName,
        ...(profile.model ? { model: profile.model } : {}),
      };

      const runner = new TaskRunner(repo, new ClaudeCodeAdapter(), bus);
      const instruction = taskWords.join(" ");

      const outcome = await runner.run({
        instruction,
        agent,
        stallTimeoutSec: options.timeout ? Number(options.timeout) : profile.stallTimeoutSec,
        ...(options.hold ? { holdForReview: true } : {}),
      });

      console.log("");
      console.log(`task      ${outcome.taskId}`);
      console.log(`branch    ${outcome.branch}`);
      console.log(`commit    ${outcome.committed ?? "(no changes)"}`);
      console.log(`merged    ${outcome.merged}`);
      if (outcome.stalled) console.log(`stalled   yes`);
      if (outcome.conflicts.length) console.log(`conflicts ${outcome.conflicts.join(", ")}`);
      if (outcome.error) console.log(`error     ${outcome.error}`);

      store.close();
      process.exitCode = outcome.ok ? 0 : 1;
    });
}

function printEvent(event: BusEvent): void {
  const payload = event.payload;
  switch (payload.type) {
    case "text":
      process.stdout.write(payload.text.endsWith("\n") ? payload.text : `${payload.text}\n`);
      break;
    case "tool_call":
      console.log(`  · ${payload.toolName}`);
      break;
    case "status":
      console.log(`[${event.agentId}] ${payload.status}${payload.detail ? ` — ${payload.detail}` : ""}`);
      break;
    case "error":
      console.error(`[${event.agentId}] error: ${payload.message}`);
      break;
    case "task_assigned":
      console.log(`[maya] ${payload.agentId} → ${payload.branch}: ${payload.summary}`);
      break;
    case "merge_result":
      console.log(
        `[maya] merge ${payload.branch}: ${payload.merged ? "ok" : `blocked (${payload.conflicts.join(", ") || "unclean tree"})`}`,
      );
      break;
    default:
      break;
  }
}
