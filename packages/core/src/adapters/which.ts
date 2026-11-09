import { spawn } from "node:child_process";

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
export function resolveExecutable(command: string): Promise<string | null> {
  const windows = process.platform === "win32";
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
      if (!windows) return resolve(lines[0] ?? null);
      const exe = lines.find((line) => line.toLowerCase().endsWith(".exe"));
      resolve(exe ?? lines[0] ?? null);
    });
  });
}
