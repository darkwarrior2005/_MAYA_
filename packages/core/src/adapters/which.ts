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
      const exe = lines.find((line) => line.toLowerCase().endsWith(".exe"));
      resolve(exe ?? lines[0] ?? null);
    });
  });
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
