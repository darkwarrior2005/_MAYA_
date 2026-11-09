/**
 * How many columns a terminal advances for a piece of text.
 *
 * The layout promises every line it emits is exactly as wide as the terminal.
 * Counting characters breaks that promise for anything drawn double-width:
 * measured at 40 columns, "done ✅ shipped 🚀 ok" came out 42 columns and a
 * line of CJK came out 44. Two columns too many wraps the line, which pushes
 * the frame down and scrolls the screen on every repaint — the exact failure
 * the fixed-width layout exists to prevent. Agents emit ✅ and 🚀 routinely,
 * so this is a normal case.
 *
 * ## Why this counts code points rather than grapheme clusters
 *
 * Measured against a real pseudoconsole, by printing a string and asking the
 * terminal where the cursor landed (`tools/verify/column-width.mjs`):
 *
 * | text                  | columns |
 * | --------------------- | ------- |
 * | `✅` U+2705           | 2       |
 * | `⚠️` U+26A0 U+FE0F    | 2       |
 * | `⚠` U+26A0            | 1       |
 * | `🇯🇵` two indicators   | 4       |
 * | `👩‍👩‍👧` ZWJ family      | 8       |
 * | `café` with U+0301    | 5       |
 *
 * ConPTY — what every modern Windows terminal runs — does not combine ZWJ
 * sequences, regional indicator pairs or combining marks. It advances per code
 * point, while absorbing a variation selector into the character before it.
 * Terminals that do cluster would draw those three cases narrower.
 *
 * So the rules here match ConPTY exactly, and on a clustering terminal they
 * over-estimate those three cases. That asymmetry is deliberate:
 * **over-estimating leaves a harmless gap at the end of a line, while
 * under-estimating wraps it and scrolls the screen.** When the terminal cannot
 * be known, err wide.
 */

/** Ranges a terminal advances two columns for. Kept sorted. */
const WIDE: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  // Symbols that are East Asian Wide despite sitting among narrow ones. Not
  // the whole block: U+2713 ✓ is narrow and U+2705 ✅ is wide.
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e], // CJK radicals, Kangxi, CJK symbols
  [0x3041, 0x33ff], // kana, Hangul compatibility jamo, CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xa960, 0xa97f], // Hangul Jamo extended-A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe10, 0xfe19], // vertical forms
  [0xfe30, 0xfe6f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6], // fullwidth signs
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f1e6, 0x1f1ff], // regional indicators, two columns each
  [0x1f200, 0x1f2ff],
  [0x1f300, 0x1faff], // emoji, pictographs, symbols
  [0x20000, 0x3fffd], // CJK extensions B and beyond
];

/** Characters that occupy no column at all. */
const ZERO_WIDTH: Array<[number, number]> = [
  [0x200b, 0x200b], // zero-width space
  [0x200e, 0x200f], // bidi marks
  [0x2028, 0x202e], // separators and bidi overrides
  [0x2060, 0x2064], // word joiner, invisible operators
  [0xfeff, 0xfeff], // byte order mark
];

const VS15 = 0xfe0e; // text presentation
const VS16 = 0xfe0f; // emoji presentation: promotes the character before it

function inRanges(code: number, ranges: Array<[number, number]>): boolean {
  for (const [from, to] of ranges) {
    if (code < from) return false;
    if (code <= to) return true;
  }
  return false;
}

export interface Unit {
  /** A character plus any variation selector riding on it. */
  text: string;
  width: number;
}

/**
 * Splits text the way the terminal advances through it: one unit per code
 * point, except that a variation selector joins the character before it.
 */
export function units(text: string): Unit[] {
  const out: Unit[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;

    if (code === VS16 || code === VS15) {
      const previous = out[out.length - 1];
      if (previous) {
        // Emoji presentation makes a narrow character wide; text
        // presentation leaves it as it is.
        if (code === VS16 && previous.width === 1) previous.width = 2;
        previous.text += char;
        continue;
      }
    }

    out.push({
      text: char,
      width: inRanges(code, ZERO_WIDTH) ? 0 : inRanges(code, WIDE) ? 2 : 1,
    });
  }
  return out;
}

/** Columns a terminal advances for this text. */
export function displayWidth(text: string): number {
  let total = 0;
  for (const unit of units(text)) total += unit.width;
  return total;
}

/**
 * The longest prefix that fits in `columns`, and the columns it uses.
 *
 * The two can differ: stopping before a double-width character leaves one
 * column spare, which the caller pads. Splitting it would emit half a glyph.
 */
export function takeColumns(
  text: string,
  columns: number,
): { text: string; width: number; rest: string } {
  if (columns <= 0) return { text: "", width: 0, rest: text };

  let taken = "";
  let width = 0;
  for (const unit of units(text)) {
    if (width + unit.width > columns) break;
    taken += unit.text;
    width += unit.width;
  }
  return { text: taken, width, rest: text.slice(taken.length) };
}
