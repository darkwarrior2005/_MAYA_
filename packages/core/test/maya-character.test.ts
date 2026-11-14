import { describe, expect, it } from "vitest";
import type { PlatformNote } from "@maya/shared-types";
import { MAYA_PROS, MAYA_TAGLINE, openPlatformWeaknesses } from "../src/agents/traits.js";

/**
 * Maya appears on the cast page beside the assistants it drives, so it needs
 * strengths and weaknesses of its own. The strengths are written down; the
 * weaknesses are not, and that is the point of these tests.
 *
 * Reading them from the platform notes means the card cannot quietly stop
 * admitting something the codebase still records: close a note and it leaves
 * the card, add one and it appears, with no second list to keep in step.
 */
const note = (id: string, severity: PlatformNote["severity"]): PlatformNote => ({
  id,
  area: "maya",
  title: `${id} title`,
  detail: `${id} detail`,
  mitigation: `${id} mitigation`,
  severity,
});

describe("what Maya admits to", () => {
  it("lists only what is still open", () => {
    // A handled note is a trap that has been dealt with. Listing it as a
    // weakness would be false modesty, and would bury the one thing that is
    // actually outstanding among things that are not.
    const weaknesses = openPlatformWeaknesses([
      note("growth", "open"),
      note("conpty", "handled"),
      note("watched", "watch"),
    ]);

    expect(weaknesses).toHaveLength(1);
    expect(weaknesses[0]).toContain("growth title");
    expect(weaknesses[0]).toContain("growth mitigation");
  });

  it("says so plainly when nothing is open", () => {
    // Rather than an empty list, which a card would render as a blank column
    // and a reader would take for "nobody has looked".
    const weaknesses = openPlatformWeaknesses([note("conpty", "handled")]);
    expect(weaknesses).toHaveLength(1);
    expect(weaknesses[0]).toMatch(/every platform note is marked handled/i);
  });

  it("carries the mitigation, not just the complaint", () => {
    // A weakness with no "and here is what is done about it" is a worse page
    // than no weakness at all.
    const [only] = openPlatformWeaknesses([note("growth", "open")]);
    expect(only).toContain("—");
    expect(only?.indexOf("growth title")).toBeLessThan(only?.indexOf("growth mitigation") ?? -1);
  });
});

describe("what Maya claims", () => {
  it("has a tagline and several strengths", () => {
    expect(MAYA_TAGLINE.length).toBeGreaterThan(10);
    expect(MAYA_PROS.length).toBeGreaterThanOrEqual(5);
  });

  it("claims only things the invariants actually promise", () => {
    // Each of these is a rule in CLAUDE.md rather than a sales line, and the
    // wording is checked so a future edit cannot turn the list into one.
    const all = MAYA_PROS.join(" ").toLowerCase();
    expect(all).toContain("operator alone merges");
    expect(all).toContain("worktree");
    expect(all).toContain("skip-all-permissions");
    // The honesty claims: measured figures, and nothing taken on trust.
    expect(all).toContain("measured");
    expect(all).toContain("not taken at its word");
  });

  it("avoids the words a measured page should not need", () => {
    const all = MAYA_PROS.join(" ").toLowerCase();
    for (const word of ["best", "fastest", "powerful", "seamless", "effortless"]) {
      expect(all, word).not.toContain(word);
    }
  });
});
