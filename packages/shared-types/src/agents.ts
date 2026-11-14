import type { AgentToolId } from "./index.js";

/**
 * How a probe went.
 *
 * `skipped` means it needed something that was not there — including a live
 * probe whose answer would be meaningless because the run it depends on
 * failed. `warn` is for something worth telling the person about that is not
 * a failure: the first live run found a VS Code `copilot` shim and marked it
 * FAIL, and then the tool worked perfectly through that shim. A caution is
 * not a failure, and scoring it as one made the card lie.
 */
export type ProbeOutcome = "pass" | "warn" | "fail" | "skipped";

export interface ProbeResult {
  id: string;
  /** What was being checked, in the person's words. */
  title: string;
  outcome: ProbeOutcome;
  /** What actually happened. Always filled in, including on a pass. */
  detail: string;
  /** How long the probe took, when it ran something. */
  ms?: number;
  /** True for a probe that spends money by running the agent for real. */
  live: boolean;
}

/** A measured trait, 0–100, for the card's stat bars. */
export interface AgentStats {
  /** How quickly it answered a trivial prompt. */
  speed: number;
  /** How much of the probe suite it passed. */
  reliability: number;
  /** How much it can do before asking: edits, shell, resuming. */
  autonomy: number;
  /** Cheap is high. Unknown is 50. */
  thrift: number;
}

export interface AgentScorecard {
  tool: AgentToolId;
  displayName: string;
  /** One line a person can read first. */
  tagline: string;
  installed: boolean;
  authenticated: boolean;
  version?: string;
  /** Where the binary actually resolved, when it is a subprocess tool. */
  resolvedPath?: string;
  probes: ProbeResult[];
  pros: string[];
  cons: string[];
  stats: AgentStats;
  /** ISO timestamp of the run that produced this. */
  checkedAt: string;
  /** True when live probes ran, so the figures came from real runs. */
  live: boolean;
}

/** A problem with the platform or with Maya itself, rather than an agent. */
export interface PlatformNote {
  id: string;
  area: "windows" | "maya" | "docs";
  title: string;
  detail: string;
  /** What Maya does about it today. */
  mitigation: string;
  severity: "open" | "handled" | "watch";
}

export interface AgentReport {
  checkedAt: string;
  live: boolean;
  agents: AgentScorecard[];
  platform: PlatformNote[];
  /** Maya itself, alongside the tools it drives. */
  maya: MayaCharacter;
}

/**
 * Maya as one of the cast, so a page showing what each assistant is good and
 * bad at can show the same of the thing orchestrating them.
 *
 * It has no `probes` and no `stats`, and that absence is deliberate: every
 * figure on an agent's card came from running that agent, and there is no
 * equivalent measurement of Maya to put beside them. Inventing a score for
 * the host would be the one unmeasured number on a page whose whole point is
 * that the numbers are measured.
 *
 * `cons` are not written by hand either — they are the platform notes that
 * are still open, so this card cannot quietly stop admitting something the
 * rest of the codebase still records.
 */
export interface MayaCharacter {
  displayName: string;
  tagline: string;
  pros: string[];
  cons: string[];
}
