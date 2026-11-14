// Builds a self-contained `maya` that runs from anywhere.
//
//   pnpm build && node tools/package.mjs
//
// Output is dist/maya: one bundled entry point, the web client beside it, and
// a package.json naming only the dependencies that cannot be bundled.
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

/**
 * Clear the last build, but never `node_modules`.
 *
 * `install.sh` and `install.ps1` run `npm install` *in here*, and the `maya`
 * on your PATH is a link to `dist/maya/maya.mjs`. Deleting this whole
 * directory therefore uninstalls the command's dependencies on the machine
 * doing the build — and the next `maya --version` dies with
 * `ERR_MODULE_NOT_FOUND: Cannot find package '@anthropic-ai/claude-agent-sdk'`,
 * which names a package the person never asked for and gives no hint that
 * repackaging was what broke it. That happened, which is why this is no
 * longer a plain `rmSync(out)`.
 *
 * Stale build output still goes: everything except `node_modules` is removed,
 * so a renamed file cannot survive into the next bundle.
 */
if (existsSync(out)) {
  for (const entry of readdirSync(out)) {
    if (entry === "node_modules") continue;
    rmSync(join(out, entry), { recursive: true, force: true });
  }
}
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

/*
 * Say whether this bundle can actually run.
 *
 * The three externals are not bundled, so the entry point imports them at
 * runtime and fails with ERR_MODULE_NOT_FOUND if they are not installed
 * beside it. That error names the package and nothing else — it does not say
 * "run npm install here", and it does not say which of the two situations
 * you are in: a fresh bundle nobody has installed into yet, or an install
 * this build just stepped on. One line now beats decoding a stack trace
 * later.
 */
const required = Object.keys(dependencies);
const missing = required.filter((name) => !existsSync(join(out, "node_modules", name)));
if (missing.length > 0) {
  console.log(
    `\n  ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not installed here yet.` +
      "\n  The bundle needs them at runtime; they are deliberately not bundled." +
      "\n\n    cd dist/maya && npm install --omit=dev\n",
  );
} else {
  console.log("  its runtime dependencies are present\n");
}
