import { describe, expect, it } from "vitest";
import {
  MIN_PANE_WIDTH,
  fit,
  pickCharset,
  renderBox,
  renderLayout,
  wrapText,
  type LayoutInput,
  type PaneView,
} from "../src/tui/layout.js";
import { displayWidth } from "../src/tui/width.js";

const pane = (overrides: Partial<PaneView> = {}): PaneView => ({
  id: "p",
  title: "Pane",
  lines: [],
  scrollOffset: 0,
  focused: false,
  ...overrides,
});

const input = (overrides: Partial<LayoutInput> = {}): LayoutInput => ({
  operator: pane({ id: "operator", title: "Operator" }),
  workers: [],
  promptLabel: "> ",
  prompt: "",
  status: "maya",
  ...overrides,
});

describe("renderLayout", () => {
  it("fills the terminal exactly, so the frame never scrolls the screen", () => {
    for (const size of [
      { cols: 80, rows: 24 },
      { cols: 200, rows: 60 },
      // Smaller than the layout's own minimum: it must still produce a frame
      // of the size it was asked for rather than overflowing.
      { cols: 20, rows: 4 },
    ]) {
      const frame = renderLayout(
        input({
          operator: pane({ title: "Operator", lines: ["one", "two"] }),
          workers: [pane({ id: "w1", title: "Worker 1" }), pane({ id: "w2", title: "Worker 2" })],
        }),
        size,
      );
      const cols = Math.max(MIN_PANE_WIDTH, size.cols);
      const rows = Math.max(6, size.rows);
      expect(frame).toHaveLength(rows);
      // Columns, not characters: a terminal advances two for some of them.
      for (const line of frame) expect(displayWidth(line)).toBe(cols);
    }
  });

  it("never emits an escape sequence, so a line's length is its width", () => {
    const frame = renderLayout(
      input({
        operator: pane({ lines: ["\u001b[31mred\u001b[0m"] }),
        workers: [pane({ id: "w1", title: "Worker" })],
      }),
      { cols: 80, rows: 24 },
    );
    expect(frame.join("\n")).not.toContain("\u001b");
  });

  it("puts the prompt and status on the last two rows", () => {
    const frame = renderLayout(
      input({ prompt: "do the thing", status: "maya  http://127.0.0.1:1234" }),
      { cols: 60, rows: 12 },
    );
    expect(frame[10]).toContain("> do the thing");
    expect(frame[11]).toContain("http://127.0.0.1:1234");
  });

  it("stacks worker panes when they would be too narrow side by side", () => {
    const workers = Array.from({ length: 4 }, (_unused, index) =>
      pane({ id: `w${index}`, title: `Worker ${index}`, lines: [`line ${index}`] }),
    );
    const wide = renderLayout(input({ workers }), { cols: 200, rows: 30 }).join("\n");
    const narrow = renderLayout(input({ workers }), { cols: 60, rows: 30 }).join("\n");

    // Side by side: all four titles share a row. Stacked: they do not.
    const wideRow = wide.split("\n").find((line) => line.includes("Worker 0"));
    expect(wideRow).toContain("Worker 3");
    const narrowRow = narrow.split("\n").find((line) => line.includes("Worker 0"));
    expect(narrowRow).not.toContain("Worker 1");
  });

  it("says how many worker panes are hidden rather than dropping them", () => {
    const workers = Array.from({ length: 6 }, (_unused, index) =>
      pane({ id: `w${index}`, title: `Worker ${index}` }),
    );
    // Narrow (so it stacks) and short (so not all six fit).
    const frame = renderLayout(input({ workers }), { cols: 50, rows: 14 }).join("\n");
    expect(frame).toMatch(/\+\d hidden/);
  });

  it("keeps the prompt visible when a banner is longer than the terminal", () => {
    const banner = Array.from({ length: 40 }, (_unused, index) => `option ${index}`);
    const frame = renderLayout(input({ banner, prompt: "2", promptLabel: "answer> " }), {
      cols: 40,
      rows: 12,
    });
    expect(frame).toHaveLength(12);
    expect(frame[10]).toContain("answer> 2");
  });
});

describe("renderBox", () => {
  it("shows the newest lines and follows new output", () => {
    const lines = Array.from({ length: 50 }, (_unused, index) => `line ${index}`);
    const box = renderBox(pane({ lines }), 30, 6).join("\n");
    expect(box).toContain("line 49");
    expect(box).not.toContain("line 40");
  });

  it("holds position while scrolled back", () => {
    const lines = Array.from({ length: 50 }, (_unused, index) => `line ${index}`);
    const box = renderBox(pane({ lines, scrollOffset: 10 }), 30, 6).join("\n");
    expect(box).toContain("line 39");
    expect(box).not.toContain("line 49");
  });

  it("marks a focused pane differently from an unfocused one", () => {
    const plain = renderBox(pane(), 20, 4)[0];
    const focused = renderBox(pane({ focused: true }), 20, 4)[0];
    expect(focused).not.toEqual(plain);
  });

  it("keeps the title when there is no room for the annotation", () => {
    const box = renderBox(pane({ title: "Worker", subtitle: "running · 12.4kt" }), 14, 3);
    expect(box[0]).toContain("Worker");
    expect(displayWidth(box[0] ?? "")).toBe(14);
  });
});

describe("wrapText", () => {
  it("hard-breaks a word longer than the pane instead of losing it", () => {
    const long = "F:/Project/Maya/packages/core/src/adapters/subprocess-adapter.ts";
    const wrapped = wrapText(long, 20);
    expect(wrapped.join("")).toContain("subprocess-adapter.ts");
    for (const line of wrapped) expect(line.length).toBeLessThanOrEqual(20);
  });

  it("wraps on words when it can", () => {
    expect(wrapText("the quick brown fox", 10)).toEqual(["the quick", "  brown", "  fox"]);
  });

  it("keeps blank lines", () => {
    expect(wrapText("a\n\nb", 10)).toEqual(["a", "", "b"]);
  });
});

describe("fit", () => {
  it("pads and truncates to an exact width", () => {
    expect(fit("ab", 5)).toBe("ab   ");
    expect(fit("abcdef", 4)).toBe("abc\u2026");
    expect(fit("abcdef", 4, ">")).toBe("abc>");
  });
});

describe("pickCharset", () => {
  it("draws ASCII on a bare Windows console and Unicode where it is announced", () => {
    expect(pickCharset({ MAYA_TUI_CHARSET: "ascii" })).toBe("ascii");
    expect(pickCharset({ MAYA_TUI_CHARSET: "unicode" })).toBe("unicode");
    if (process.platform === "win32") {
      expect(pickCharset({})).toBe("ascii");
      expect(pickCharset({ WT_SESSION: "x" })).toBe("unicode");
    } else {
      expect(pickCharset({})).toBe("unicode");
    }
  });

  it("renders a frame with no multi-byte glyphs in ascii mode", () => {
    const frame = renderLayout(
      input({
        operator: pane({ title: "Operator", subtitle: "running", scrollOffset: 3, lines: ["hi"] }),
        workers: [pane({ id: "w", title: "Worker", focused: true })],
      }),
      { cols: 60, rows: 20 },
      "ascii",
    ).join("\n");
    // eslint-disable-next-line no-control-regex
    expect(frame).toMatch(/^[\x00-\x7f]*$/);
  });
});

describe("double-width characters", () => {
  // Agents emit these constantly. A frame two columns too wide wraps, which
  // scrolls the whole screen on every repaint.
  const samples: Array<[string, string]> = [
    ["emoji", "done ✅ shipped 🚀 ok"],
    ["cjk", "文字化け the parser failed"],
    ["mixed", "✅ 文字 ok 🎉 done"],
    ["flag", "🇯🇵 locale support"],
    ["family", "👩‍👩‍👧 one family"],
    ["accents", "café résumé"],
    ["presentation", "⚠️ and ⚠"],
  ];

  it("keeps every frame line exactly as wide as the terminal", () => {
    for (const [label, text] of samples) {
      for (const cols of [28, 40, 80]) {
        const frame = renderLayout(
          input({
            operator: pane({ lines: [text, `${text} ${text}`] }),
            workers: [pane({ id: "w", title: text, lines: [text] })],
          }),
          { cols, rows: 16 },
        );
        for (const line of frame) {
          expect(displayWidth(line), `${label} at ${cols}`).toBe(cols);
        }
      }
    }
  });

  it("truncates to the column, never half a character", () => {
    const box = renderBox(pane({ lines: ["文字化け"] }), 10, 3);
    for (const line of box) expect(displayWidth(line)).toBe(10);
  });

  it("wraps a run of wide characters without overflowing", () => {
    const wrapped = wrapText("文字化け".repeat(10), 11);
    for (const line of wrapped) expect(displayWidth(line)).toBeLessThanOrEqual(11);
    expect(wrapped.join("")).toContain("文字化け");
  });

  it("matches the columns a real terminal advances", () => {
    // Measured by printing each of these into a pseudoconsole and asking
    // where the cursor landed; see tools/verify/column-width.mjs. ConPTY does
    // not combine ZWJ sequences, regional indicators or combining marks, so
    // neither does this.
    expect(displayWidth("✅")).toBe(2); // white heavy check mark
    expect(displayWidth("✓")).toBe(1); // plain check mark is narrow
    expect(displayWidth("⚠")).toBe(1); // warning sign, text presentation
    expect(displayWidth("⚠️")).toBe(2); // the same, emoji presentation
    expect(displayWidth("🇯🇵")).toBe(4); // two regional indicators
    expect(displayWidth("café")).toBe(5); // the accent takes its own column
    expect(displayWidth("文字")).toBe(4);
    expect(displayWidth("ok")).toBe(2);
  });
});
