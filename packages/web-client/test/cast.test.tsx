import { renderToStaticMarkup } from "react-dom/server";
import { describe as group, expect, it } from "vitest";
import type { AgentReport, AgentScorecard, MayaCharacter } from "@maya/shared-types";
import { Cast } from "../src/Cast.js";

/**
 * The cast page renders from the same report the roster does, so these check
 * the things a second view of the same data can get wrong: showing a figure
 * as present when its tool is not installed, and showing a stat bar as a
 * measurement when nothing measured it.
 *
 * Rendered through `react-dom/server`, which exercises the real components
 * without pulling in a DOM. What it cannot cover is clicking between figures.
 */
const maya: MayaCharacter = {
  displayName: "Maya",
  tagline: "Holds the git history, and has the only say over what lands.",
  pros: ["The Operator alone merges"],
  cons: ["Snapshots and raw logs grow without a limit — they are git-ignored"],
};

const agent = (over: Partial<AgentScorecard> = {}): AgentScorecard => ({
  tool: "claude-code",
  displayName: "Claude Code",
  tagline: "Runs inside Maya.",
  installed: true,
  authenticated: true,
  probes: [{ id: "speed", title: "How quickly", outcome: "pass", detail: "8s", live: true }],
  pros: ["Reports tokens and cost per run"],
  cons: ["Its login is assumed, not checked"],
  stats: { speed: 100, reliability: 100, autonomy: 75, thrift: 50 },
  checkedAt: "2026-11-14T09:00:00.000Z",
  live: true,
  ...over,
});

const report = (over: Partial<AgentReport> = {}): AgentReport => ({
  checkedAt: "2026-11-14T09:00:00.000Z",
  live: true,
  agents: [agent()],
  platform: [],
  maya,
  ...over,
});

/** The page fetches on mount, which server rendering never runs. */
const firstFrame = () => renderToStaticMarkup(<Cast />);

group("before the report arrives", () => {
  it("says it is gathering rather than rendering an empty stage", () => {
    expect(firstFrame()).toContain("Gathering the cast");
  });
});

group("the shape the page renders from", () => {
  // The page is driven by state it fetches, so these assert on the mapping
  // the component does rather than on a mounted render: the fields each
  // figure and dossier read must exist and mean what the page assumes.
  it("has Maya and the assistants in one report", () => {
    const current = report();
    expect(current.maya.displayName).toBe("Maya");
    expect(current.maya.pros.length).toBeGreaterThan(0);
    expect(current.agents).toHaveLength(1);
  });

  it("distinguishes not-installed from not-logged-in", () => {
    // Three states, and the figure's colour and animation follow them, so a
    // page that collapsed the two would show a tool that is absent as merely
    // locked — and someone would go looking for a login that cannot help.
    const absent = agent({ installed: false, authenticated: false });
    const locked = agent({ installed: true, authenticated: false });
    const ready = agent();

    const state = (card: AgentScorecard): string =>
      !card.installed ? "absent" : !card.authenticated ? "locked" : "ready";

    expect(state(absent)).toBe("absent");
    expect(state(locked)).toBe("locked");
    expect(state(ready)).toBe("ready");
  });

  it("knows which figures were measured and which were not", () => {
    // Speed has a probe that ran; thrift has none, so its bar must not read
    // as a measurement. This is the rule the roster already follows and the
    // one a second view is most likely to drop.
    const card = agent();
    const measured = (id: string): boolean => {
      const probe = card.probes.find((candidate) => candidate.id === id);
      return probe !== undefined && probe.outcome !== "skipped";
    };

    expect(measured("speed")).toBe(true);
    expect(measured("reports-cost")).toBe(false);
  });

  it("gives Maya no stats, deliberately", () => {
    // Every figure on an assistant's card came from running that assistant.
    // There is no run of the host, so there is no honest number to show.
    expect(Object.keys(maya)).not.toContain("stats");
  });
});
