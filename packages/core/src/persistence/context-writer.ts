import { mkdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AgentDescriptor } from "@maya/shared-types";
import type { MayaPaths } from "../config/maya-config.js";

export interface ContextSnapshot {
  agent: AgentDescriptor;
  taskSummary: string;
  transcript: string;
  status: string;
}

const RETRYABLE = new Set(["EBUSY", "EPERM", "EACCES"]);
const MAX_ATTEMPTS = 5;

/**
 * Writes paired .md/.html snapshots. Always temp-file-then-rename: writing in
 * place races with the PTY process holding a handle on the same path, which on
 * Windows surfaces as EBUSY/EPERM and would otherwise kill the daemon.
 */
export class ContextWriter {
  constructor(
    private readonly paths: MayaPaths,
    private readonly onWarn: (message: string) => void = () => {},
  ) {}

  write(snapshot: ContextSnapshot): { md: string; html: string } | null {
    const dir = this.paths.agentDir(snapshot.agent.id);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      this.onWarn(`context snapshot dir unavailable (${dir}): ${String(error)}`);
      return null;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const md = renderMarkdown(snapshot);
    const html = renderHtml(snapshot);

    const written = {
      md: join(dir, `${stamp}_context.md`),
      html: join(dir, `${stamp}_context.html`),
    };

    const ok =
      this.atomicWrite(written.md, md) &&
      this.atomicWrite(written.html, html) &&
      this.atomicWrite(join(dir, "latest.md"), md) &&
      this.atomicWrite(join(dir, "latest.html"), html);

    return ok ? written : null;
  }

  /** Returns false instead of throwing: a lost snapshot must not take down the run. */
  private atomicWrite(target: string, contents: string): boolean {
    const temp = `${target}.${process.pid}.tmp`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        writeFileSync(temp, contents, "utf8");
        renameSync(temp, target);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        cleanup(temp);
        if (!RETRYABLE.has(code) || attempt === MAX_ATTEMPTS) {
          this.onWarn(`context snapshot failed for ${target}: ${code || String(error)}`);
          return false;
        }
        sleep(attempt * 50);
      }
    }
    return false;
  }
}

function cleanup(temp: string): void {
  try {
    unlinkSync(temp);
  } catch {
    // already gone
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renderMarkdown(s: ContextSnapshot): string {
  return [
    `# ${s.agent.displayName}`,
    "",
    `- **Agent id**: ${s.agent.id}`,
    `- **Role**: ${s.agent.role}`,
    `- **Tool**: ${s.agent.tool}${s.agent.model ? ` (${s.agent.model})` : ""}`,
    `- **Status**: ${s.status}`,
    `- **Captured**: ${new Date().toISOString()}`,
    "",
    "## Task",
    "",
    s.taskSummary,
    "",
    "## Transcript",
    "",
    s.transcript,
    "",
  ].join("\n");
}

function renderHtml(s: ContextSnapshot): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(s.agent.displayName)} — Maya context</title>
<style>
  body { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; line-height: 1.5; }
  dt { font-weight: 600; }
  pre { background: #f4f4f5; padding: 1rem; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }
  @media (prefers-color-scheme: dark) {
    body { background: #18181b; color: #e4e4e7; }
    pre { background: #27272a; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(s.agent.displayName)}</h1>
<dl>
  <dt>Agent id</dt><dd>${escapeHtml(s.agent.id)}</dd>
  <dt>Role</dt><dd>${escapeHtml(s.agent.role)}</dd>
  <dt>Tool</dt><dd>${escapeHtml(s.agent.tool)}${s.agent.model ? ` (${escapeHtml(s.agent.model)})` : ""}</dd>
  <dt>Status</dt><dd>${escapeHtml(s.status)}</dd>
  <dt>Captured</dt><dd>${new Date().toISOString()}</dd>
</dl>
<h2>Task</h2>
<pre>${escapeHtml(s.taskSummary)}</pre>
<h2>Transcript</h2>
<pre>${escapeHtml(s.transcript)}</pre>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
