import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { AdapterPlugin } from "../config/maya-config.js";
import type { AgentAdapter } from "./adapter.js";

export interface PluginLoadResult {
  loaded: AgentAdapter[];
  /** One line per plugin that could not be loaded, for doctor and the log. */
  problems: string[];
}

export interface PluginContext {
  repoRoot: string;
  /** Where an adapter should mirror its raw output. */
  rawLogPath: (agentId: string) => string;
}

/**
 * Loads the adapters a project named in `.maya/config.json`.
 *
 * **This runs code the config points at.** That is the whole feature — a
 * project adds a tool without changing Maya — but it means the `adapters`
 * list is as trusted as the code in the repository itself. It is opt-in
 * (absent by default), `.maya/` is git-excluded so the list is not something
 * a clone brings with it, and every module path is printed as it loads, so a
 * plugin cannot be added silently.
 *
 * A plugin that fails to load is reported rather than thrown: one bad entry
 * should not stop a session whose other workers are fine. A worker that
 * actually needs it still fails loudly, because the registry has no adapter
 * under that id.
 */
export async function loadAdapterPlugins(
  plugins: AdapterPlugin[],
  context: PluginContext,
  announce: (message: string) => void = () => undefined,
): Promise<PluginLoadResult> {
  const loaded: AgentAdapter[] = [];
  const problems: string[] = [];

  for (const plugin of plugins) {
    try {
      const specifier = resolveSpecifier(plugin.module, context.repoRoot);
      announce(`loading adapter "${plugin.id}" from ${specifier}`);

      const module = (await import(specifier)) as Record<string, unknown>;
      const exported = module[plugin.export ?? "default"];
      if (typeof exported !== "function") {
        problems.push(
          `adapter "${plugin.id}": ${plugin.module} has no ${
            plugin.export ? `export named "${plugin.export}"` : "default export"
          } to call`,
        );
        continue;
      }

      const factory = exported as (options: unknown) => unknown;
      const adapter = await factory({ ...plugin.options, ...context });

      const invalid = describeIfNotAdapter(adapter);
      if (invalid) {
        problems.push(`adapter "${plugin.id}": ${invalid}`);
        continue;
      }

      const candidate = adapter as AgentAdapter;
      if (candidate.id !== plugin.id) {
        // The config's id is what worker profiles refer to; a mismatch would
        // register the adapter under a name nothing resolves.
        problems.push(
          `adapter "${plugin.id}": the module registered itself as "${candidate.id}"`,
        );
        continue;
      }
      loaded.push(candidate);
    } catch (error) {
      problems.push(
        `adapter "${plugin.id}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { loaded, problems };
}

/**
 * A bare name is a package; anything path-shaped is resolved against the
 * project, so a plugin can live beside the code it drives.
 */
function resolveSpecifier(module: string, repoRoot: string): string {
  if (module.startsWith("./") || module.startsWith("../") || isAbsolute(module)) {
    return pathToFileURL(resolve(repoRoot, module)).href;
  }
  return module;
}

/** Says what is missing rather than just rejecting, so the config can be fixed. */
function describeIfNotAdapter(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "the factory did not return an object";
  const adapter = value as Partial<AgentAdapter>;
  const missing = (["id", "displayName", "capabilities", "check", "start"] as const).filter(
    (key) => adapter[key] === undefined,
  );
  return missing.length === 0 ? null : `the adapter is missing ${missing.join(", ")}`;
}
