import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { MayaPaths, loadConfig, loadRegistry, probeAgents } from "@maya/core";
import type { AgentReport } from "@maya/shared-types";

interface AgentsOptions {
  dir: string;
  live?: boolean;
  json?: boolean;
}

/** Where the arena page reads its figures from. */
export const AGENT_REPORT_FILE = "agents-report.json";

export function registerAgents(program: Command): void {
  program
    .command("agents")
    .description("Test each configured agent and write a scorecard of what it can do")
    .option("-d, --dir <dir>", "project directory", ".")
    .option(
      "--live",
      "give each agent a real task to do — this spends money, and Copilot charges a premium request per run",
      false,
    )
    .option("--json", "print the report instead of a summary", false)
    .action(async (options: AgentsOptions) => {
      const repoRoot = resolve(options.dir);
      const paths = new MayaPaths(repoRoot);
      paths.ensureDirs();
      const config = loadConfig(paths);

      const { registry, problems } = await loadRegistry(paths, config, (message) =>
        console.log(`[maya] ${message}`),
      );
      for (const problem of problems) console.error(`[maya] ${problem}`);

      if (options.live) {
        console.log(
          "[maya] live probes: each agent gets two real tasks in a throwaway directory.\n" +
            "[maya] This spends money. Ctrl-C now if that is not what you wanted.",
        );
      }

      const report = await probeAgents(registry, config, {
        ...(options.live ? { live: true } : {}),
        onProgress: (message) => console.log(`[maya] ${message}`),
      });

      const file = join(paths.stateDir, AGENT_REPORT_FILE);
      writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        printSummary(report, file);
      }
    });
}

function printSummary(report: AgentReport, file: string): void {
  console.log("");
  for (const agent of report.agents) {
    const ran = agent.probes.filter((probe) => probe.outcome !== "skipped");
    const passed = ran.filter((probe) => probe.outcome === "pass").length;
    console.log(`${agent.displayName}  ${passed}/${ran.length} checks`);
    console.log(`  ${agent.tagline}`);
    for (const probe of agent.probes) {
      const mark = probe.outcome === "pass" ? "ok  " : probe.outcome === "fail" ? "FAIL" : "skip";
      console.log(`  ${mark} ${probe.title} — ${probe.detail}`);
    }
    console.log("");
  }

  const open = report.platform.filter((note) => note.severity === "open");
  if (open.length > 0) {
    console.log(`${open.length} open platform issue(s):`);
    for (const note of open) console.log(`  - ${note.title}`);
    console.log("");
  }

  console.log(`written to ${file}`);
  console.log(
    report.live
      ? "These figures came from real runs."
      : "Static checks only — add --live to have each agent actually do something.",
  );
}
