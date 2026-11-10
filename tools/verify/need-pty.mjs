// Shared by every harness that needs a real pseudoconsole.
//
// node-pty is an optional dependency with no Linux prebuild (see
// docs/FINDINGS.md), so on Linux it is usually simply absent. A harness that
// crashed with "Cannot find module 'node-pty'" looked like a broken checkout,
// which is why this says what it is and exits 0: a check that could not run is
// not a check that failed, and CI should not go red for a missing optional
// package.
//
// It also means `node tools/verify/panes.mjs` on a fresh Linux box prints one
// line telling you what to install, rather than a stack trace.
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * node-pty's `spawn`, or a clean exit explaining why this harness was skipped.
 *
 * @param {string} what the harness's own name, for the message.
 * @returns {{ spawn: Function }}
 */
export function needPty(what) {
  const require_ = createRequire(join(repoRoot, "packages/core/package.json"));
  try {
    return { spawn: require_("node-pty").spawn };
  } catch (error) {
    // First line only: the require stack underneath it is three more lines of
    // noise in what should be a one-glance "this was skipped, and why".
    const why = (error instanceof Error ? error.message : String(error)).split("\n")[0];
    console.log(`SKIPPED  ${what} — needs the optional node-pty package.`);
    console.log(`         ${why}`);
    console.log(
      "         node-pty ships prebuilds for Windows and macOS only; on Linux it",
    );
    console.log(
      "         needs a C++ toolchain. Install it with `pnpm add -w -D node-pty`,",
    );
    console.log("         or run the harnesses that do not need a terminal:");
    console.log("         mcp.mjs, agents.mjs, packaged.mjs");
    process.exit(0);
  }
}

export { repoRoot };
