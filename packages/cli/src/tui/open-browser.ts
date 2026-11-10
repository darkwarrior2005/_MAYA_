import { spawn } from "node:child_process";

/**
 * Hands a URL to the platform's browser, reporting whether it launched one.
 *
 * Written out rather than taken from a dependency because it is three lines per
 * platform, and because the process must be fully detached: a browser launcher
 * that stayed a child would keep the pane view from exiting when the user quits.
 *
 * `MAYA_BROWSER=none` skips the launch and reports false, for a session with no
 * browser to open — over SSH, in a container, or under test.
 */
export async function openBrowser(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (env["MAYA_BROWSER"] === "none") return false;

  const { command, args } = launcher(url);
  // Wait for the spawn to succeed or fail before answering.
  //
  // This used to resolve immediately and return true, with the error listener
  // firing into an already-settled promise. On a headless Linux box there is
  // often no `xdg-open`, so Maya said it had opened a browser and nothing
  // happened. Node emits exactly one of `spawn` or `error`, so there is no
  // guess involved — and the caller already knows how to say "open it
  // yourself".
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      // `start` is a cmd.exe builtin, so Windows needs a shell to reach it.
      shell: process.platform === "win32",
    });
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      // Detach only once it is up: unref'ing a process that never started
      // leaves nothing to report.
      child.unref();
      resolve(true);
    });
  });
}

function launcher(url: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    // The empty string is `start`'s title argument; without it a quoted URL is
    // taken as the window title and nothing opens.
    return { command: "start", args: ['""', `"${url}"`] };
  }
  if (process.platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}
