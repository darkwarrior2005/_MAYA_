// Does the packaged `maya` run on its own, from somewhere else?
//
//   pnpm build && pnpm package && node tools/verify/packaged.mjs
//
// The bundle is copied to a temp directory with only its declared
// dependencies, and driven from a cwd that has nothing to do with this
// repository — which is the only way to catch a path resolved relative to the
// workspace instead of to the bundle.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const require_ = createRequire(join(repoRoot, "packages/core/package.json"));

const results = [];
const check = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
};

/**
 * The directory a package lives in. Resolving "<name>/package.json" does not
 * work for a package that does not export it, so this walks up from whatever
 * the entry point resolves to until it finds the manifest.
 */
function packageRoot(name) {
  let dir = join(require_.resolve(name), "..");
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, "package.json"))) {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (manifest.name === name) return dir;
    }
    dir = join(dir, "..");
  }
  throw new Error(`could not locate the package directory for ${name}`);
}

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "pipe", ...options });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
    child.on("error", (error) => resolve({ code: -1, out: String(error) }));
  });
}

const bundle = join(repoRoot, "dist/maya");
if (!existsSync(join(bundle, "maya.mjs"))) {
  console.error("run `pnpm package` first");
  process.exit(2);
}

// --- stand the bundle up somewhere unrelated --------------------------------
const home = mkdtempSync(join(tmpdir(), "maya-pkg-"));
cpSync(bundle, home, { recursive: true });

const manifest = JSON.parse(readFileSync(join(home, "package.json"), "utf8"));
const needed = [
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
];
mkdirSync(join(home, "node_modules"), { recursive: true });
for (const name of needed) {
  // Copy from the workspace rather than installing from the network: this is
  // checking the bundle, not npm.
  try {
    cpSync(packageRoot(name), join(home, "node_modules", ...name.split("/")), { recursive: true });
  } catch (error) {
    console.log(`note  could not stage ${name}: ${String(error).slice(0, 90)}`);
  }
}
check("the bundle declares what it cannot inline", needed.length > 0, needed.join(", "));

const entry = join(home, "maya.mjs");
const elsewhere = mkdtempSync(join(tmpdir(), "maya-elsewhere-"));

// --- it runs ----------------------------------------------------------------
const help = await run(process.execPath, [entry, "--help"], { cwd: elsewhere });
check("`maya --help` runs from an unrelated directory", help.code === 0, help.out.split("\n")[0]);
check(
  "every command is present",
  ["init", "run", "start", "attach", "web", "doctor"].every((c) => help.out.includes(` ${c} `)),
);

// --- it manages a project it has never seen ---------------------------------
const project = mkdtempSync(join(tmpdir(), "maya-project-"));
const init = await run(process.execPath, [entry, "init", project], { cwd: elsewhere });
check("`maya init` prepares a fresh project", init.code === 0, init.out.trim().split("\n").pop());
check("it wrote the state directory", existsSync(join(project, ".maya", "config.json")));

const doctor = await run(process.execPath, [entry, "doctor", "-d", project], { cwd: elsewhere });
check("`maya doctor` reports on git and the event store", doctor.out.includes("event store"));
check("the native sqlite module loaded from the bundle", doctor.out.includes("WAL mode"));
check("no adapter plugins are configured by default", doctor.out.includes("no adapter plugins"));

// --- the web client travels with it -----------------------------------------
check("the web client was packaged beside the bundle", existsSync(join(home, "web-client/index.html")));

const web = spawn(process.execPath, [entry, "web", "-d", project, "--no-open", "--port", "7911"], {
  cwd: elsewhere,
  stdio: "pipe",
});
let webOut = "";
web.stdout.on("data", (d) => (webOut += d));
web.stderr.on("data", (d) => (webOut += d));
await new Promise((r) => setTimeout(r, 3000));

check("`maya web` serves the project", /web interface on http/.test(webOut), webOut.trim().split("\n")[0]);
check("it did not report a missing client", !webOut.includes("not built"));

let page = { status: 0, body: "" };
try {
  const response = await fetch("http://127.0.0.1:7911/");
  page = { status: response.status, body: await response.text() };
} catch (error) {
  page = { status: -1, body: String(error) };
}
check("the packaged client is served", page.status === 200 && page.body.includes("<title>Maya"), `status ${page.status}`);

web.kill();
await new Promise((r) => setTimeout(r, 500));

const failed = results.filter((pass) => !pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
console.log(`bundle: ${home}`);
process.exit(failed === 0 ? 0 : 1);
