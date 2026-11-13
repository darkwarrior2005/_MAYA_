import type { AgentEvent, AgentId, AgentToolId, TokenUsage } from "@maya/shared-types";

export interface AdapterCapabilities {
  streaming: boolean;
  structuredOutput: boolean;
  resumable: boolean;
}

export interface AgentRunOptions {
  agentId: AgentId;
  cwd: string;
  prompt: string;
  model?: string;
  resumeSessionId?: string;
  /** Silence budget before the watchdog declares a stall. */
  stallTimeoutSec?: number;
  /**
   * Per-worker tool permissions, in the underlying CLI's own pattern syntax
   * (Copilot: `write(path?)`, `shell(cmd?)`). Set on the worker profile so one
   * worker can be allowed to run commands while another is limited to edits.
   */
  allowedTools?: string[];
  deniedTools?: string[];
  /**
   * Budgets the tool enforces itself, where it can. The adapter-agnostic
   * ceilings live in `withRunLimits`; these are the native ones, which stop a
   * run before it spends rather than after.
   */
  maxTurns?: number;
  maxBudgetUsd?: number;
}

export interface AgentRunResult {
  ok: boolean;
  stalled: boolean;
  sessionId?: string;
  usage?: TokenUsage;
  error?: string;
}

export type AgentEventListener = (event: AgentEvent) => void;

export interface AgentHandle {
  readonly agentId: AgentId;
  onEvent(listener: AgentEventListener): () => void;
  /** Resolves once the run finishes, fails, or is declared stalled. */
  waitForCompletion(): Promise<AgentRunResult>;
  interrupt(): Promise<void>;
  kill(): Promise<void>;
}

export interface AgentAdapter {
  readonly id: AgentToolId;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;
  /** Reports whether the underlying tool is installed and authenticated. */
  check(): Promise<AdapterHealth>;
  start(options: AgentRunOptions): Promise<AgentHandle>;
}

export interface AdapterHealth {
  installed: boolean;
  authenticated: boolean;
  /**
   * Whether `authenticated` was proven rather than assumed.
   *
   * None of the wrapped tools offer a cheap way to ask "are my credentials
   * still good?" — only a real call settles it. So `authenticated: true` with
   * `verified: false` means "nothing says otherwise", which is weaker than it
   * reads. The first live run found a Claude Code whose stored OAuth session
   * had expired while this check reported it as logged in.
   */
  verified?: boolean;
  version?: string;
  detail?: string;
  /**
   * The executable this adapter will actually spawn, resolved on PATH.
   *
   * Which binary runs is not always the one the person thinks: on a machine
   * with VS Code installed, `copilot` resolves to a shim under the editor's
   * directory, ahead of the real CLI. The adapter is the only thing that
   * knows its own binary, so it reports the path and `maya doctor` and the
   * agent probes both read it from here — rather than either of them keeping
   * a tool-name-to-binary map that has to be updated whenever an adapter is
   * added. Absent for an adapter that runs in-process.
   */
  resolvedPath?: string;
}
