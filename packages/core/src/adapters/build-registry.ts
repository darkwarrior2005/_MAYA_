import type { MayaConfig, MayaPaths } from "../config/maya-config.js";
import { AntigravityCliAdapter } from "./antigravity-cli.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { CodexCliAdapter } from "./codex-cli.js";
import { CopilotCliAdapter } from "./copilot-cli.js";
import { loadAdapterPlugins } from "./plugin-loader.js";
import { AdapterRegistry } from "./registry.js";

/** Every adapter Maya ships, wired to mirror raw PTY output into .maya/logs. */
export function buildRegistry(paths: MayaPaths): AdapterRegistry {
  const rawLogPath = (agentId: string): string => paths.agentLog(agentId);
  return new AdapterRegistry()
    .register(new ClaudeCodeAdapter())
    .register(new CopilotCliAdapter({ rawLogPath }))
    .register(new AntigravityCliAdapter({ rawLogPath }))
    .register(new CodexCliAdapter({ rawLogPath }));
}

/**
 * The registry a session actually runs with: everything Maya ships, plus the
 * adapters the project named in its config.
 *
 * A plugin that fails to load is returned as a problem rather than thrown, so
 * one bad entry cannot stop a session whose other workers are fine. A worker
 * that needs the missing adapter still fails, with the registry saying which
 * id it could not resolve.
 */
export async function loadRegistry(
  paths: MayaPaths,
  config: MayaConfig,
  announce?: (message: string) => void,
): Promise<{ registry: AdapterRegistry; problems: string[] }> {
  const registry = buildRegistry(paths);
  const plugins = config.adapters ?? [];
  if (plugins.length === 0) return { registry, problems: [] };

  const { loaded, problems } = await loadAdapterPlugins(
    plugins,
    { repoRoot: paths.repoRoot, rawLogPath: (agentId) => paths.agentLog(agentId) },
    announce,
  );
  for (const adapter of loaded) registry.register(adapter);
  return { registry, problems };
}
