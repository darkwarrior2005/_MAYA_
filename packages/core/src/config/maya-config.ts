import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolId } from "@maya/shared-types";

export interface WorkerProfile {
  id: string;
  tool: AgentToolId;
  displayName: string;
  model?: string;
  /** Seconds of silence before the liveness watchdog declares the agent stalled. */
  stallTimeoutSec: number;
  /**
   * Off by default for the subprocess-driven tools: Copilot CLI and Antigravity
   * CLI each need a one-time interactive login and are less settled than the
   * SDK path, so a project opts into them deliberately.
   */
  enabled: boolean;
}

export interface MayaConfig {
  version: 1;
  operator: WorkerProfile;
  workers: WorkerProfile[];
}

export const DEFAULT_STALL_TIMEOUT_SEC = 60;

export const defaultConfig = (): MayaConfig => ({
  version: 1,
  operator: {
    id: "operator",
    tool: "claude-code",
    displayName: "Operator",
    stallTimeoutSec: DEFAULT_STALL_TIMEOUT_SEC,
    enabled: true,
  },
  workers: [
    {
      id: "worker-claude",
      tool: "claude-code",
      displayName: "Worker (Claude Code)",
      stallTimeoutSec: DEFAULT_STALL_TIMEOUT_SEC,
      enabled: true,
    },
    {
      id: "worker-copilot",
      tool: "copilot-cli",
      displayName: "Worker (Copilot CLI)",
      stallTimeoutSec: DEFAULT_STALL_TIMEOUT_SEC,
      enabled: false,
    },
    {
      id: "worker-antigravity",
      tool: "antigravity-cli",
      displayName: "Worker (Antigravity CLI)",
      stallTimeoutSec: DEFAULT_STALL_TIMEOUT_SEC,
      enabled: false,
    },
  ],
});

export function enabledWorkers(config: MayaConfig): WorkerProfile[] {
  return config.workers.filter((worker) => worker.enabled);
}

/** Resolves every path Maya owns inside a managed project. */
export class MayaPaths {
  constructor(readonly repoRoot: string) {}

  get stateDir(): string {
    return join(this.repoRoot, ".maya");
  }
  get configFile(): string {
    return join(this.stateDir, "config.json");
  }
  get dbFile(): string {
    return join(this.stateDir, "state.db");
  }
  get lockFile(): string {
    return join(this.stateDir, "daemon.lock");
  }
  agentDir(agentId: string): string {
    return join(this.stateDir, "agents", agentId);
  }
  agentLog(agentId: string): string {
    return join(this.stateDir, "logs", `${agentId}.ndjson`);
  }

  ensureDirs(): void {
    mkdirSync(join(this.stateDir, "agents"), { recursive: true });
    mkdirSync(join(this.stateDir, "logs"), { recursive: true });
  }
}

/**
 * Keeps `.maya/` out of the user's history without touching their own .gitignore.
 * `.git/info/exclude` is local-only and never committed.
 */
export function excludeStateDirFromGit(repoRoot: string): void {
  const excludeFile = join(repoRoot, ".git", "info", "exclude");
  if (!existsSync(excludeFile)) return;
  const current = readFileSync(excludeFile, "utf8");
  if (current.includes(".maya/")) return;
  appendFileSync(excludeFile, `${current.endsWith("\n") ? "" : "\n"}.maya/\n`);
}

export function loadConfig(paths: MayaPaths): MayaConfig {
  if (!existsSync(paths.configFile)) {
    const fresh = defaultConfig();
    paths.ensureDirs();
    writeFileSync(paths.configFile, `${JSON.stringify(fresh, null, 2)}\n`, "utf8");
    return fresh;
  }
  return JSON.parse(readFileSync(paths.configFile, "utf8")) as MayaConfig;
}
