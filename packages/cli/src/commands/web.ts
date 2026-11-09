import { resolve } from "node:path";
import type { Command } from "commander";
import {
  Daemon,
  EventBus,
  EventStore,
  RepoManager,
  findWebClient,
  isLockAlive,
  loadConfig,
  readLock,
} from "@maya/core";
import { openBrowser } from "../tui/open-browser.js";

interface WebOptions {
  dir: string;
  port?: string;
  open?: boolean;
}

export function registerWeb(program: Command): void {
  program
    .command("web")
    .description("Serve the web interface for a project and keep it running")
    .option("-d, --dir <dir>", "project directory", ".")
    .option("-p, --port <port>", "port to listen on")
    .option("--no-open", "print the address instead of opening a browser")
    .action(async (options: WebOptions) => {
      const repoRoot = resolve(options.dir);
      const repo = new RepoManager(repoRoot);
      await repo.openOrInit();

      const existing = readLock(repo.paths);
      if (existing && isLockAlive(existing)) {
        // The session already has a daemon; serving a second one would split
        // the view in two, which is the opposite of the point.
        const address = `http://127.0.0.1:${existing.port}`;
        console.log(`[maya] already running for this project — ${address}`);
        if (options.open !== false) await openBrowser(address);
        return;
      }

      const config = loadConfig(repo.paths);
      const store = new EventStore(repo.paths.dbFile);
      const bus = new EventBus(store);
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
        },
      });

      const lock = await daemon.start();
      console.log(`[maya] web interface on ${daemon.address} (pid ${lock.pid})`);
      if (!clientDir) {
        console.log("[maya] the web client is not built — run `pnpm build` and reload");
      }
      console.log("[maya] Ctrl-C to stop");

      if (options.open !== false) await openBrowser(daemon.address);

      const shutdown = async (): Promise<void> => {
        await daemon.stop();
        store.close();
        process.exit(0);
      };
      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());

      // Nothing else holds the process open once the command's action returns.
      await new Promise<void>(() => {});
    });
}
