import { spawn } from "node:child_process";

/** PATH lookup without a dependency; `shell: false` keeps the name out of a shell. */
export function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = spawn(process.platform === "win32" ? "where" : "which", [command], {
      stdio: "ignore",
      shell: false,
    });
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0));
  });
}
