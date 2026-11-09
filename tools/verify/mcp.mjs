// Drives the Maya MCP server the way an agent's client would: over stdio,
// against a real daemon serving a real repository.
//
//   pnpm build && node tools/verify/mcp.mjs
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const require_ = createRequire(join(repoRoot, "packages/mcp-server/package.json"));
// resolve() gives a Windows path; import() needs a file:// URL.
const { Client } = await import(pathToFileURL(require_.resolve("@modelcontextprotocol/sdk/client/index.js")).href);
const { StdioClientTransport } = await import(pathToFileURL(require_.resolve("@modelcontextprotocol/sdk/client/stdio.js")).href);
const core = await import(new URL("packages/core/dist/index.js", new URL("../../", import.meta.url)).href);
const { EventStore, EventBus, Daemon, MayaPaths, loadConfig, UsageTracker, publishAgentEvent } = core;
const coreRequire = createRequire(join(repoRoot, "packages/core/package.json"));
const { simpleGit } = coreRequire("simple-git");

const results = [];
const check = (name, pass, detail = "") => {
  results.push(pass);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a project with a session in it -----------------------------------------
const project = mkdtempSync(join(tmpdir(), "maya-mcp-"));
const git = simpleGit(project);
await git.init();
await git.addConfig("user.email", "t@maya.local");
await git.addConfig("user.name", "T");
await git.raw(["checkout", "-B", "main"]);
writeFileSync(join(project, "README.md"), "# demo\n", "utf8");
await git.add(["-A"]);
await git.commit("Initial layout");

const paths = new MayaPaths(project);
paths.ensureDirs();
const config = loadConfig(paths);
const store = new EventStore(paths.dbFile);
const bus = new EventBus(store);
const usage = new UsageTracker().seed(store.since(0));
bus.subscribe((event) => usage.record(event));
const conflicts = new core.DeferredConflictResolver(bus);
const daemon = new Daemon({
  paths,
  bus,
  store,
  web: { repoRoot: project, git, store, bus, config, conflicts, usage: () => usage.totals() },
});
await daemon.start();

bus.publish("main", null, "task_assigned", {
  type: "task_assigned", taskId: "t1", agentId: "worker-claude",
  branch: "maya/t1/worker-claude", summary: "add a parser",
});
bus.publish("main", "worker-claude", "usage", {
  type: "usage", agentId: "worker-claude",
  usage: { inputTokens: 4, outputTokens: 220, cacheReadTokens: 43093, costUsd: 0.41 },
});
publishAgentEvent(bus, "worker-claude", {
  type: "text", agentId: "worker-claude", text: "Wrote src/parser.ts and its tests.",
});

// --- connect as an agent would ----------------------------------------------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(repoRoot, "packages/mcp-server/dist/main.js")],
  env: { ...process.env, MAYA_PROJECT: project },
});
const client = new Client({ name: "verify", version: "0.0.0" });
await client.connect(transport);

const listed = await client.listTools();
const names = listed.tools.map((tool) => tool.name).sort();
check("the server advertises its tools", names.length >= 9, names.join(", "));
check(
  "it offers the read and write tools an agent needs",
  ["maya_session", "maya_say", "maya_tell_user", "maya_answer_question"].every((n) =>
    names.includes(n),
  ),
);
check(
  "it offers nothing that pretends to queue work",
  !names.some((n) => /add_task|create_task|assign/.test(n)),
  "a tool that looks like it assigns work but does not would be worse than none",
);

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  return { text: result.content.map((part) => part.text ?? "").join("\n"), isError: result.isError };
};

const session = await call("maya_session");
check("maya_session reports the repository and branch", session.text.includes("branch:     main"), session.text.split("\n")[1]);

const activity = await call("maya_recent_activity", { limit: 10 });
check("maya_recent_activity shows what the worker did", activity.text.includes("Wrote src/parser.ts"));
check("it shows the assignment too", activity.text.includes("assigned worker-claude"));

const usageOut = await call("maya_usage");
check("maya_usage counts cached tokens and cost", usageOut.text.includes("43.3k") && usageOut.text.includes("$0.41"), usageOut.text.split("\n")[0]);

const tree = await call("maya_git_tree");
check("maya_git_tree shows the commit", tree.text.includes("Initial layout"));

const files = await call("maya_files");
check("maya_files lists the repository", files.text.includes("README.md"));

// --- posting ----------------------------------------------------------------
await call("maya_say", { message: "MCP-POSTED-THIS to the shared chat" });
await call("maya_tell_user", { message: "MCP-ASKED-THIS directly" });
await sleep(300);

const log = store.since(0);
const said = log.find((e) => e.payload.text === "MCP-POSTED-THIS to the shared chat");
check("maya_say lands on the main channel", said?.channel === "main", said?.channel ?? "missing");
const told = log.find((e) => String(e.payload.text ?? "").includes("MCP-ASKED-THIS"));
check("maya_tell_user lands on the secret channel", told?.channel === "secret", told?.channel ?? "missing");
check("the marker is stripped from what the person reads", told?.payload.text === "MCP-ASKED-THIS directly", told?.payload.text);

// --- answering the Operator --------------------------------------------------
const nothing = await call("maya_pending_question");
check("it says when nothing is waiting", nothing.text.includes("Nothing is waiting"));

const asked = conflicts.resolve({
  question: "src/parser.ts conflicts with main. How should this be handled?",
  options: [
    { id: "hold", label: "Keep the work on its branch" },
    { id: "discard", label: "Abandon this branch" },
  ],
});
await sleep(200);

const question = await call("maya_pending_question");
check("it surfaces the Operator's question", question.text.includes("How should this be handled?"));
check("with its options", question.text.includes("Abandon this branch"));

await call("maya_answer_question", { answer: "2" });
const answer = await Promise.race([asked, sleep(4000).then(() => null)]);
check("maya_answer_question reaches the Operator", answer?.chosen === "discard", JSON.stringify(answer));

// --- no session ---------------------------------------------------------------
const elsewhere = mkdtempSync(join(tmpdir(), "maya-nosession-"));
const missing = await call("maya_session", { project: elsewhere });
check(
  "it explains itself when no session is running",
  missing.isError === true && missing.text.includes("maya web"),
  missing.text.slice(0, 90),
);

await client.close();
await daemon.stop();
store.close();

const failed = results.filter((pass) => !pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
