#!/usr/bin/env node
import { Command } from "commander";
import { registerAgents } from "./commands/agents.js";
import { registerAttach } from "./commands/attach.js";
import { registerInit } from "./commands/init.js";
import { registerRun } from "./commands/run.js";
import { registerStart } from "./commands/start.js";
import { registerWeb } from "./commands/web.js";
import { registerDoctor } from "./commands/doctor.js";

const program = new Command();

program
  .name("maya")
  .description("Multi-agent AI coding orchestration — one Operator, many wrapped coding CLIs")
  .version("1.1.0");

registerInit(program);
registerRun(program);
registerStart(program);
registerAttach(program);
registerWeb(program);
registerDoctor(program);
registerAgents(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
