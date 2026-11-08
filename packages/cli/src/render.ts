import type { BusEvent } from "@maya/shared-types";

/** One renderer for the terminal view of the bus, shared by `run` and `start`. */
export function printEvent(event: BusEvent): void {
  const payload = event.payload;
  const who = event.agentId ?? "maya";

  switch (payload.type) {
    case "text":
      process.stdout.write(`[${who}] ${payload.text.trimEnd()}\n`);
      break;
    case "tool_call":
      console.log(`[${who}]   · ${payload.toolName}`);
      break;
    case "status":
      console.log(`[${who}] ${payload.status}${payload.detail ? ` — ${payload.detail}` : ""}`);
      break;
    case "error":
      console.error(`[${who}] error: ${payload.message}`);
      break;
    case "task_assigned":
      console.log(`[maya] ${payload.agentId} → ${payload.branch}: ${payload.summary}`);
      break;
    case "task_completed":
      console.log(`[maya] ${payload.agentId} finished ${payload.ok ? "ok" : "with errors"}`);
      break;
    case "merge_result":
      console.log(
        `[maya] merge ${payload.branch}: ${
          payload.merged ? "ok" : `blocked (${payload.conflicts.join(", ") || "unclean tree"})`
        }`,
      );
      break;
    case "conflict_prompt":
      console.log(`[maya] needs a decision: ${payload.question}`);
      break;
    default:
      break;
  }
}
