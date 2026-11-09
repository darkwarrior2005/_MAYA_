import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

/**
 * Claude Code refuses to start on Windows without git-bash, and only says so
 * on stderr. Rather than make every user export CLAUDE_CODE_GIT_BASH_PATH by
 * hand, derive it: Git for Windows ships bash.exe next to git.exe, and the
 * install is often not on PATH as `bash`.
 */
export async function findGitBash(): Promise<string | null> {
  if (process.platform !== "win32") return null;

  const fromEnv = process.env["CLAUDE_CODE_GIT_BASH_PATH"];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const onPath = await resolveCommand("bash");
  if (onPath && onPath.toLowerCase().endsWith(".exe") && existsSync(onPath)) return onPath;

  // Which git wins on PATH varies — Git for Windows puts git.exe in <root>\cmd,
  // while an MSYS2 shell resolves it to <root>\ucrt64\bin — so walk up from
  // wherever it landed and look for bash at each ancestor.
  const gitExe = await resolveCommand("git");
  if (gitExe) {
    let dir = dirname(gitExe);
    for (let depth = 0; depth < 4; depth++) {
      for (const candidate of [
        join(dir, "bin", "bash.exe"),
        join(dir, "usr", "bin", "bash.exe"),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  for (const candidate of [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Git", "bin", "bash.exe"),
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  return null;
}

function resolveCommand(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = spawn("where", [command], { shell: false });
    let output = "";
    probe.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    probe.on("error", () => resolve(null));
    probe.on("close", (code) => {
      if (code !== 0) return resolve(null);
      const first = output.split(/\r?\n/).find((line) => line.trim().length > 0);
      resolve(first ? first.trim() : null);
    });
  });
}
