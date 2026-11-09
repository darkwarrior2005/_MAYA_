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
  version?: string;
  detail?: string;
}
