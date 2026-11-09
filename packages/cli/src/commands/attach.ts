import { resolve } from "node:path";
import type { Command } from "commander";
import { MayaPaths, isLockAlive, loadConfig, readLock } from "@maya/core";
import { PaneManager } from "../tui/pane-manager.js";
import { postMessage } from "../tui/post-message.js";
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
      const daemonAddress = `http://127.0.0.1:${lock.port}`;
      const panes: PaneManager = new PaneManager({
        daemonAddress,
        ...paneSpecs(config),
        // Through the daemon, not this process's own store: the daemon owns
        // the bus, and a row written from here would reach no one.
        onUserMessage: (text) => {
          void postMessage(daemonAddress, text).catch((error: unknown) =>
            panes.announce(
              `could not send: ${error instanceof Error ? error.message : String(error)}`,
            ),
          );
        },
      });

      if (!panes.interactive) {
        console.error("`maya attach` needs a terminal; this process has no TTY");
        process.exitCode = 1;
        return;
      }

      // Attaching is a view onto someone else's run: it can say something on
      // the session's chat, but it does not own the Operator, so merge
      // questions are answered in the terminal that started the run.
      panes.announce("attached — the session's own terminal answers merge questions");
      await panes.start();
    });
}
