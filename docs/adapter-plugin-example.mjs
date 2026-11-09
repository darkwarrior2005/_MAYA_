// An adapter a project adds itself, as a worked example.
//
// Put this at <project>/plugins/echo-tool.mjs and add to <project>/.maya/config.json:
//
//   "adapters": [
//     { "id": "echo-tool", "module": "./plugins/echo-tool.mjs",
//       "export": "createAdapter", "options": { "note": "from the project" } }
//   ],
//   "workers": [
//     { "id": "worker-echo", "tool": "echo-tool", "displayName": "Worker (Echo)",
//       "stallTimeoutSec": 30, "enabled": true }
//   ]
//
// Maya imports the module and calls the export, so an entry here runs code.
// `.maya/` is git-excluded and the list is empty by default, and every module
// path is printed as it loads — but the `adapters` list is as trusted as the
// repository it sits in.
//
// `module` is a path relative to the project root, or a package name.
// `options` is merged with { repoRoot, rawLogPath } and passed to the factory.

/**
 * @param {{ repoRoot: string, rawLogPath: (agentId: string) => string, note?: string }} options
 */
export function createAdapter(options) {
  return {
    // Must equal the `id` in the config; a mismatch is reported and refused,
    // because worker profiles resolve adapters by that name.
    id: "echo-tool",
    displayName: `Echo Tool (${options.note ?? "unnamed"})`,

    capabilities: { streaming: true, structuredOutput: false, resumable: false },

    /** `maya doctor` calls this. Say what is wrong, not just that it is. */
    async check() {
      return { installed: true, authenticated: true, detail: "always available" };
    },

    /**
     * Starts one run. The handle streams normalized events and resolves when
     * the tool is finished.
     *
     * Two things the built-in adapters learned the hard way and a new one
     * should copy: emit a `done` event with the tool's own view of success
     * rather than relying on an exit code, and emit `error` with `fatal: true`
     * for anything that means the run did not really happen — a fatal error
     * stops Maya merging a branch where nothing was done.
     */
    async start(run) {
      const listeners = new Set();
      return {
        agentId: run.agentId,
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async waitForCompletion() {
          const emit = (event) => {
            for (const listener of listeners) listener(event);
          };
          emit({ type: "status", agentId: run.agentId, status: "running" });
          emit({
            type: "text",
            agentId: run.agentId,
            text: `echo: ${run.prompt.split("\n")[0]}`,
          });
          emit({ type: "done", agentId: run.agentId, ok: true });
          return { ok: true, stalled: false };
        },
        async interrupt() {},
        async kill() {},
      };
    },
  };
}
