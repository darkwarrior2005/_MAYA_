import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Finds the built web client, or returns undefined when it has not been built.
 *
 * Undefined is a normal state, not an error: `maya run` never serves a page,
 * and a checkout that has not run `pnpm build` yet should say so when the
 * browser asks rather than failing at startup.
 */
export function findWebClient(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env["MAYA_WEB_CLIENT"];
  if (override) return existsSync(override) ? override : undefined;

  for (const candidate of [
    // In the workspace: packages/core/{src,dist}/daemon → packages/web-client.
    "../../../web-client/dist/",
    // Packaged: the client copied in beside the compiled core.
    "../web-client/",
  ]) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) return path;
  }
  return undefined;
}
