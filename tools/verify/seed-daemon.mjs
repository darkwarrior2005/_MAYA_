// Stands up a real daemon with a seeded event log, so `maya attach` has a
// session to render without spending an agent run. Stays alive until killed.
//
//   node tools/verify/seed-daemon.mjs <repo-dir>
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const core = new URL("packages/core/dist/index.js", new URL("../../", import.meta.url));
const { EventStore, EventBus, Daemon, MayaPaths, loadConfig } = await import(core.href);

const root = process.argv[2];
if (!root) {
  console.error(`usage: node tools/verify/seed-daemon.mjs <repo-dir>  (from ${repoRoot})`);
  process.exit(2);
}

const paths = new MayaPaths(root);
paths.ensureDirs();
loadConfig(paths);

const store = new EventStore(paths.dbFile);
const bus = new EventBus(store);
const daemon = new Daemon({ paths, bus, store });
const lock = await daemon.start();
console.log(`seeded daemon on port ${lock.port}`);

bus.publish("main", null, "task_assigned", {
  type: "task_assigned",
  taskId: "t1",
  agentId: "worker-claude",
  branch: "maya/t1/worker-claude",
  summary: "add a NOTES.md",
});
bus.publish("main", "worker-claude", "status", {
  type: "status",
  agentId: "worker-claude",
  status: "running",
});
bus.publish("main", "worker-claude", "tool_call", {
  type: "tool_call",
  agentId: "worker-claude",
  toolName: "Write",
});
bus.publish("main", "worker-claude", "text", {
  type: "text",
  agentId: "worker-claude",
  text: "WORKER-LINE-ALPHA wrote NOTES.md",
});
bus.publish("main", "worker-claude", "usage", {
  type: "usage",
  agentId: "worker-claude",
  usage: { inputTokens: 12400, outputTokens: 310 },
});
// A worker trying to corrupt the frame with escape codes of its own.
bus.publish("main", "worker-claude", "text", {
  type: "text",
  agentId: "worker-claude",
  text: "\u001b[2J\u001b[1;1HESCAPED-LINE should stay inside its pane",
});
bus.publish("main", null, "merge_result", {
  type: "merge_result",
  taskId: "t1",
  branch: "maya/t1/worker-claude",
  merged: true,
  conflicts: [],
});

process.on("SIGTERM", async () => {
  await daemon.stop();
  store.close();
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
