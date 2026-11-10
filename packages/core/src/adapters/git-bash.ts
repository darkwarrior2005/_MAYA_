import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
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

  // A Scoop, Chocolatey or GitHub Desktop install puts a tiny shim on PATH,
  // so walking up from where `where git` landed never reaches bash. Asking
  // git where its own helpers live points at the real installation instead.
  const execPath = await runGit(["--exec-path"]);
  if (execPath) {
    let dir = execPath;
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
    join(process.env["USERPROFILE"] ?? "", "scoop", "apps", "git", "current", "bin", "bash.exe"),
    ["C:", "ProgramData", "chocolatey", "lib", "git", "tools", "bin", "bash.exe"].join(sep),
  ]) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  return null;
}

/** Runs git and returns its first line of output, or null. */
function runGit(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = spawn("git", args, { shell: false });
    let output = "";
    probe.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    probe.on("error", () => resolve(null));
    probe.on("close", (code) => {
      if (code !== 0) return resolve(null);
      resolve(firstLine(output));
    });
  });
}

function firstLine(output: string): string | null {
  const line = output.split(new RegExp("\\r?\\n")).find((c) => c.trim().length > 0);
  return line ? line.trim() : null;
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
