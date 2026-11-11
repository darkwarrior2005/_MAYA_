import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

/** PATH lookup without a dependency; `shell: false` keeps the name out of a shell. */
export async function commandExists(command: string): Promise<boolean> {
  return (await resolveExecutable(command)) !== null;
}

/**
 * Full path to a command on PATH, or null.
 *
 * node-pty spawns the binary directly and does no PATH or PATHEXT lookup of
 * its own, so a bare name that works in a shell ("agy") fails there with
 * "File not found". On Windows a real .exe is preferred over an
 * extensionless shell shim, which node-pty cannot execute either.
 */
export async function resolveExecutable(command: string): Promise<string | null> {
  const windows = process.platform === "win32";
  // Off Windows, walk PATH rather than shell out.
  //
  // `which` is not part of POSIX and plenty of minimal Linux images — the kind
  // CI and containers use — do not ship it. When it is missing, spawn fails
  // with ENOENT and every tool is reported as not installed, which reads as
  // "nothing is set up" instead of "the probe is broken".
  if (!windows) return findOnPath(command);
  return new Promise((resolve) => {
    const probe = spawn(windows ? "where" : "which", [command], { shell: false });
    let output = "";
    probe.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    probe.on("error", () => resolve(null));
    probe.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const lines = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) return resolve(null);
      resolve(preferSpawnable(lines));
    });
  });
}

/**
 * Which of `where`'s matches Windows can actually start.
 *
 * `npm i -g` installs three entry points for one command: an extensionless
 * shell script for Git Bash and friends, a `.cmd`, and a `.ps1`. `where`
 * prints the exact-name match first, which is the extensionless one — and
 * `CreateProcess` cannot run it, so the spawn fails with ENOENT naming a file
 * that plainly exists. That is what happened the first time Maya drove a
 * freshly installed `codex`: "spawn ...\\npm\\codex ENOENT".
 *
 * So the extension decides, not the order `where` happened to print. `.exe`
 * first because a real binary needs no shell; then the ones cmd.exe can run,
 * which `needsShell` in subprocess-adapter.ts knows to wrap. `.ps1` is never
 * chosen: cmd.exe cannot run it either.
 *
 * If nothing matches, the first line is still returned rather than null. The
 * command *is* installed, and saying "not on PATH" would send the reader off
 * to reinstall something that is already there; a failed spawn naming the
 * path it tried is the more honest outcome.
 */
export function preferSpawnable(paths: string[]): string | null {
  for (const extension of [".exe", ".com", ".cmd", ".bat"]) {
    const match = paths.find((path) => path.toLowerCase().endsWith(extension));
    if (match) return match;
  }
  return paths[0] ?? null;
}

/** The first entry on PATH that exists and is executable. */
async function findOnPath(command: string): Promise<string | null> {
  const executable = async (path: string): Promise<boolean> => {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  // A path, not a name: it is not PATH's business.
  if (command.includes("/") || isAbsolute(command)) {
    return (await executable(command)) ? command : null;
  }

  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (await executable(candidate)) return candidate;
  }
  return null;
}
