import { resolve } from "node:path";
import type { Command } from "commander";
import { MayaPaths, isLockAlive, loadConfig, readLock } from "@maya/core";
import { PaneManager } from "../tui/pane-manager.js";
import { paneSpecs } from "../tui/specs.js";

interface AttachOptions {
  dir: string;
}

export function registerAttach(program: Command): void {
  program
    .command("attach")
    .description("Open the pane view on a Maya session that is already running")
    .option("-d, --dir <dir>", "project directory", ".")
    .action(async (options: AttachOptions) => {
      const paths = new MayaPaths(resolve(options.dir));
      const lock = readLock(paths);

      if (!lock) {
        console.error("no Maya daemon is running for this project — start one with `maya start`");
        process.exitCode = 1;
        return;
      }
      if (!isLockAlive(lock)) {
        console.error(
          `the recorded daemon (pid ${lock.pid}) is gone — remove .maya/daemon.lock or run \`maya start\``,
        );
        process.exitCode = 1;
        return;
      }

      const config = loadConfig(paths);
      const panes = new PaneManager({
        daemonAddress: `http://127.0.0.1:${lock.port}`,
        ...paneSpecs(config),
      });

      if (!panes.interactive) {
        console.error("`maya attach` needs a terminal; this process has no TTY");
        process.exitCode = 1;
        return;
      }

      // Attaching is a view onto someone else's run: it replays the whole
      // session from the event log, but it does not own the Operator, so it
      // cannot answer merge questions or hand out new tasks.
      panes.announce("attached read-only — the session's own terminal answers questions");
      await panes.start();
    });
}
