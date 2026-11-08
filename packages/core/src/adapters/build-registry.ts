import type { MayaPaths } from "../config/maya-config.js";
import { AntigravityCliAdapter } from "./antigravity-cli.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CopilotCliAdapter } from "./copilot-cli.js";
import { AdapterRegistry } from "./registry.js";

/** Every adapter Maya ships, wired to mirror raw PTY output into .maya/logs. */
export function buildRegistry(paths: MayaPaths): AdapterRegistry {
  const rawLogPath = (agentId: string): string => paths.agentLog(agentId);
  return new AdapterRegistry()
    .register(new ClaudeCodeAdapter())
    .register(new CopilotCliAdapter({ rawLogPath }))
    .register(new AntigravityCliAdapter({ rawLogPath }));
}
