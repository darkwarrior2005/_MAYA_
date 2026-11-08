#!/usr/bin/env node
import { Command } from "commander";
import { registerInit } from "./commands/init.js";
import { registerRun } from "./commands/run.js";
import { registerDoctor } from "./commands/doctor.js";

const program = new Command();

program
  .name("maya")
  .description("Multi-agent AI coding orchestration — one Operator, many wrapped coding CLIs")
  .version("0.1.0");

registerInit(program);
registerRun(program);
registerDoctor(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
