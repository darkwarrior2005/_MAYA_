// Builds a self-contained `maya` that runs from anywhere.
//
//   pnpm build && node tools/package.mjs
//
// Output is dist/maya: one bundled entry point, the web client beside it, and
// a package.json naming only the dependencies that cannot be bundled.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const require_ = createRequire(join(repoRoot, "packages/core/package.json"));
const esbuild = require_("esbuild");

const out = join(repoRoot, "dist/maya");
const corePkg = JSON.parse(readFileSync(join(repoRoot, "packages/core/package.json"), "utf8"));
const cliPkg = JSON.parse(readFileSync(join(repoRoot, "packages/cli/package.json"), "utf8"));

/**
 * What must stay outside the bundle.
 *
 * better-sqlite3 and node-pty load a native `.node` binary at runtime, which
 * a bundler cannot inline. The Agent SDK resolves files of its own relative to
 * its package directory, so bundling it would break those lookups.
 */
const EXTERNAL = ["better-sqlite3", "node-pty", "@anthropic-ai/claude-agent-sdk"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const bundle = async (entry, outfile) =>
  esbuild.build({
    entryPoints: [join(repoRoot, entry)],
    outfile: join(out, outfile),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: EXTERNAL,
    banner: {
      // `ws` and simple-git reach for CJS globals an ESM bundle lacks.
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        "import { fileURLToPath as __fileURLToPath } from 'node:url';",
        "import { dirname as __dirname_ } from 'node:path';",
        "const require = __createRequire(import.meta.url);",
        "const __filename = __fileURLToPath(import.meta.url);",
        "const __dirname = __dirname_(__filename);",
      ].join(String.fromCharCode(10)),
    },
    logLevel: "info",
  });

await bundle("packages/cli/dist/main.js", "maya.mjs");
// The MCP server ships alongside, so an installed Maya can be driven by
// another agent without the workspace being present.
await bundle("packages/mcp-server/dist/main.js", "maya-mcp.mjs");

// The daemon serves this; findWebClient() looks for it beside the bundle.
cpSync(join(repoRoot, "packages/web-client/dist"), join(out, "web-client"), { recursive: true });

const dependencies = {};
for (const name of EXTERNAL) {
  const range = corePkg.dependencies?.[name] ?? corePkg.optionalDependencies?.[name];
  if (range) dependencies[name] = range;
}
const optional = {};
if (corePkg.optionalDependencies?.["node-pty"]) {
  optional["node-pty"] = corePkg.optionalDependencies["node-pty"];
  delete dependencies["node-pty"];
}

writeFileSync(
  join(out, "package.json"),
  `${JSON.stringify(
    {
      name: "maya",
      version: cliPkg.version,
      private: true,
      type: "module",
      bin: { maya: "./maya.mjs", "maya-mcp": "./maya-mcp.mjs" },
      engines: { node: ">=20.13" },
      dependencies,
      optionalDependencies: optional,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

writeFileSync(
  join(out, "README.md"),
  [
    "# maya (packaged)",
    "",
    "    npm install --omit=dev",
    "    npm link        # or add this directory to PATH",
    "    maya --help",
    "",
    "`node-pty` is optional and only needed for the `pty` transport and the",
    "verification harnesses; it has no Linux prebuild.",
    "",
    "## Driving Maya from another agent",
    "",
    "`maya-mcp` is an MCP server over stdio. Point an MCP client at it and set",
    "`MAYA_PROJECT` to the repository Maya is managing:",
    "",
    '    { "command": "maya-mcp", "env": { "MAYA_PROJECT": "/path/to/project" } }',
    "",
    "It needs a session running — `maya web` or `maya start` — and says so when",
    "there is not one.",
    "",
  ].join("\n"),
  "utf8",
);

console.log(`\npackaged into ${out}`);
