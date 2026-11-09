import { resolve } from "node:path";
import type { Command } from "commander";
import {
  Daemon,
  DeferredConflictResolver,
  EventBus,
  EventStore,
  HoldOnConflictResolver,
  Operator,
  RepoManager,
  TaskQueue,
  describeRecovery,
  enabledWorkers,
  findWebClient,
  loadConfig,
  loadRegistry,
  recoverSession,
  readLock,
  UsageTracker,
  isLockAlive,
  type ConflictResolver,
} from "@maya/core";
import { promptConflictsInTerminal } from "../terminal-conflicts.js";
import type { OperatorRunReport } from "@maya/core";
import { printEvent } from "../render.js";
import { PaneManager } from "../tui/pane-manager.js";
import { paneSpecs } from "../tui/specs.js";

interface StartOptions {
  dir: string;
  port?: string;
  yes?: boolean;
  tui?: boolean;
}

export function registerStart(program: Command): void {
  program
    .command("start")
    .description("Run tasks across workers in parallel, with the Operator merging results")
    .argument("<tasks...>", "one or more tasks, each handed to its own worker")
    .option("-d, --dir <dir>", "project directory", ".")
    .option("-p, --port <port>", "port for the local daemon")
    .option("-y, --yes", "never prompt on conflicts; hold the branch instead", false)
    .option("-t, --tui", "watch the run in tmux-style panes instead of a scrolling log", false)
    .action(async (tasks: string[], options: StartOptions) => {
      const repoRoot = resolve(options.dir);
      const repo = new RepoManager(repoRoot);
      await repo.openOrInit();

      const existing = readLock(repo.paths);
      if (existing && isLockAlive(existing)) {
        console.error(
          `a Maya daemon is already running for this project (pid ${existing.pid}, port ${existing.port})`,
        );
        process.exitCode = 1;
        return;
      }

      const config = loadConfig(repo.paths);
      const workers = enabledWorkers(config);
      if (workers.length === 0) {
        console.error("no enabled workers in .maya/config.json");
        process.exitCode = 1;
        return;
      }

      const store = new EventStore(repo.paths.dbFile);
      const bus = new EventBus(store);

      // One running total, seeded from history then updated per event, so
      // the info panel does not rescan the whole log every time it refreshes.
      const usage = new UsageTracker().seed(store.since(0));
      bus.subscribe((event) => usage.record(event));

      // Whatever the last daemon left behind, before anything of this session
      // is running and could be confused with it.
      const recovery = await recoverSession({ paths: repo.paths, git: repo.git, store });
      const recoveryNotes = describeRecovery(recovery);

      const { registry, problems } = await loadRegistry(repo.paths, config, (message) =>
        recoveryNotes.push(message),
      );
      recoveryNotes.push(...problems);

      // One resolver whatever the interface, so a merge question can be
      // answered from the terminal or from the browser and the first answer
      // wins. `--yes` still means never ask.
      const deferred = options.yes ? undefined : new DeferredConflictResolver(bus);
      const conflicts: ConflictResolver = deferred ?? new HoldOnConflictResolver(bus);

      // The daemon serves the web interface on the same port, so `/localhost`
      // in the pane view has somewhere real to go.
      const clientDir = findWebClient();
      const daemon = new Daemon({
        paths: repo.paths,
        bus,
        store,
        ...(options.port ? { port: Number(options.port) } : {}),
        web: {
          repoRoot,
          git: repo.git,
          store,
          bus,
          config,
          ...(clientDir ? { clientDir } : {}),
          usage: () => usage.totals(),
          ...(deferred ? { conflicts: deferred } : {}),
        },
      });
      const lock = await daemon.start();

      let panes: PaneManager | undefined;
      if (options.tui) {
        panes = new PaneManager({
          daemonAddress: daemon.address,
          ...paneSpecs(config),
          ...(deferred ? { conflicts: deferred } : {}),
          onUserMessage: (text) =>
            bus.publish("main", null, "user_message", { type: "user_message", text }),
        });
        if (!panes.interactive) {
          console.error("[maya] no TTY — falling back to the scrolling log");
          panes = undefined;
        }
      }

      // Exactly one renderer owns stdout: the log printer would scribble over
      // the pane frame, and a readline prompt would fight it for stdin.
      let stopPrompting: (() => void) | undefined;
      if (!panes) {
        bus.subscribe(printEvent);
        if (deferred) stopPrompting = promptConflictsInTerminal(deferred);
      }

      if (!panes) {
        console.log(`[maya] daemon on ${daemon.address} (pid ${lock.pid})`);
        console.log(`[maya] ${workers.length} worker(s): ${workers.map((w) => w.id).join(", ")}`);
      }

      for (const note of recoveryNotes) {
        if (panes) panes.announce(note);
        else console.log(`[maya] ${note}`);
      }

      const closed = panes ? panes.start() : Promise.resolve();

      try {
        const report = await operatorRun();
        const summary = summarize(report);

        if (panes?.active) {
          summary.forEach((line) => panes?.announce(line));
          panes.announce("run finished — /localhost for the web view, /quit to leave");
          await closed;
        } else {
          // The user may have left the panes mid-run; the result still matters.
          summary.forEach((line) => console.log(line));
        }

        process.exitCode = report.held.length === 0 ? 0 : 1;
      } finally {
        stopPrompting?.();
        panes?.stop();
        await daemon.stop();
        store.close();
      }

      function operatorRun(): Promise<OperatorRunReport> {
        const operator = new Operator({
          repo,
          registry,
          bus,
          queue: new TaskQueue(store.database),
          conflicts,
          workers,
          // Lets the Operator describe each change for the commit message
          // instead of restating the task.
          operator: config.operator,
        });
        return operator.run(tasks);
      }
    });
}

function summarize(report: OperatorRunReport): string[] {
  const lines = [""];
  for (const outcome of report.outcomes) {
    const state = outcome.stalled ? "stalled" : outcome.ok ? "ok" : "failed";
    lines.push(`  ${outcome.agent.id.padEnd(18)} ${state.padEnd(8)} ${outcome.branch}`);
  }
  lines.push("");
  lines.push(`merged ${report.merged.length}: ${report.merged.join(", ") || "-"}`);
  lines.push(`held   ${report.held.length}: ${report.held.join(", ") || "-"}`);
  return lines;
}
