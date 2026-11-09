import { displayWidth, takeColumns } from "./width.js";

/**
 * The pane layout is a pure function: state plus a terminal size in, a grid of
 * plain strings out. Nothing here touches stdout, so the whole tmux-style
 * arrangement — split rules, scrollback windows, truncation — is unit-testable
 * without a terminal, which is the only practical way to check it behaves on
 * both a wide Windows Terminal and an 80x24 Linux console.
 *
 * Every returned line is exactly `cols` characters wide and contains no escape
 * sequences, so its length is its visible width.
 */

export interface PaneView {
  id: string;
  title: string;
  /** Short right-hand annotation, e.g. a status or token count. */
  subtitle?: string;
  /** Logical lines, oldest first; wrapped to the pane width at render time. */
  lines: string[];
  /** Display lines scrolled back from the live tail. 0 follows the output. */
  scrollOffset: number;
  focused: boolean;
}

export interface LayoutInput {
  operator: PaneView;
  workers: PaneView[];
  /** Multi-line notice above the prompt, e.g. a conflict question. */
  banner?: string[];
  promptLabel: string;
  prompt: string;
  status: string;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export type Charset = "unicode" | "ascii";

interface Glyphs {
  h: string;
  v: string;
  tl: string;
  tr: string;
  bl: string;
  br: string;
  /** Marks a pane scrolled back from its live tail. */
  up: string;
  /** Marks a truncated line. */
  cut: string;
}

const UNICODE: { plain: Glyphs; focus: Glyphs } = {
  plain: { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘", up: "↑", cut: "…" },
  focus: { h: "═", v: "║", tl: "╔", tr: "╗", bl: "╚", br: "╝", up: "↑", cut: "…" },
};

const ASCII: { plain: Glyphs; focus: Glyphs } = {
  plain: { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+", up: "^", cut: ">" },
  focus: { h: "=", v: "|", tl: "#", tr: "#", bl: "#", br: "#", up: "^", cut: ">" },
};

/** Narrower than this and a pane has no room for content worth reading. */
export const MIN_PANE_WIDTH = 28;
/** Two borders plus one content row. */
export const MIN_PANE_HEIGHT = 3;

/**
 * Legacy `conhost` windows commonly run a non-UTF-8 code page, where box-drawing
 * characters arrive as mojibake. Windows Terminal and the usual third-party
 * terminals announce themselves, so treat an unannounced Windows console as the
 * old one and draw in ASCII.
 */
export function pickCharset(env: NodeJS.ProcessEnv = process.env): Charset {
  if (env["MAYA_TUI_CHARSET"] === "ascii") return "ascii";
  if (env["MAYA_TUI_CHARSET"] === "unicode") return "unicode";
  if (process.platform !== "win32") return "unicode";
  const announced = env["WT_SESSION"] ?? env["TERM_PROGRAM"] ?? env["ConEmuANSI"];
  return announced ? "unicode" : "ascii";
}

export function renderLayout(
  input: LayoutInput,
  size: TerminalSize,
  charset: Charset = "unicode",
): string[] {
  const cols = Math.max(MIN_PANE_WIDTH, size.cols);
  const rows = Math.max(6, size.rows);

  const banner = (input.banner ?? []).flatMap((line) => wrapText(line, cols));
  // The prompt and status bar are never sacrificed: without them the user
  // cannot see what they are typing or where the daemon is.
  const chromeRows = 2;
  const bannerRows = Math.min(banner.length, Math.max(0, rows - chromeRows - MIN_PANE_HEIGHT));
  const paneRows = rows - chromeRows - bannerRows;

  const body = renderPanes(input, { cols, rows: paneRows }, charset);

  const cut = (charset === "ascii" ? ASCII : UNICODE).plain.cut;
  const lines = [
    ...body,
    ...banner.slice(0, bannerRows).map((line) => fit(line, cols, cut)),
    fit(`${input.promptLabel}${input.prompt}`, cols, cut),
    fit(input.status, cols, cut),
  ];

  // Guard against an arithmetic slip leaving the frame the wrong height: a
  // frame shorter or taller than the terminal scrolls the whole screen.
  return lines.slice(0, rows).concat(Array(Math.max(0, rows - lines.length)).fill(" ".repeat(cols)));
}

function renderPanes(input: LayoutInput, size: TerminalSize, charset: Charset): string[] {
  const workers = input.workers;
  if (workers.length === 0) {
    return renderBox(input.operator, size.cols, size.rows, charset);
  }

  // The Operator keeps the main pane, as in the wireframe, but never so much
  // that a worker pane collapses below a readable height.
  const workerBand = Math.min(
    size.rows - MIN_PANE_HEIGHT,
    Math.max(MIN_PANE_HEIGHT, Math.floor(size.rows / 2)),
  );
  const operatorRows = size.rows - workerBand;
  if (workerBand < MIN_PANE_HEIGHT) {
    return renderBox(input.operator, size.cols, size.rows, charset);
  }

  return [
    ...renderBox(input.operator, size.cols, operatorRows, charset),
    ...renderWorkerBand(workers, { cols: size.cols, rows: workerBand }, charset),
  ];
}

/**
 * Side by side while each pane stays readable, stacked otherwise. A terminal
 * too short to stack them all shows as many as fit and says how many are
 * hidden, rather than silently dropping a worker's output.
 */
function renderWorkerBand(workers: PaneView[], size: TerminalSize, charset: Charset): string[] {
  const perPane = Math.floor(size.cols / workers.length);
  if (workers.length === 1 || perPane >= MIN_PANE_WIDTH) {
    const columns = workers.map((worker, index) =>
      renderBox(
        worker,
        // The last column absorbs the remainder so the band fills the width.
        index === workers.length - 1 ? size.cols - perPane * (workers.length - 1) : perPane,
        size.rows,
        charset,
      ),
    );
    return Array.from({ length: size.rows }, (_row, y) =>
      columns.map((column) => column[y] ?? "").join(""),
    );
  }

  const visible = Math.max(1, Math.floor(size.rows / MIN_PANE_HEIGHT));
  const shown = workers.slice(0, Math.min(visible, workers.length));
  const hidden = workers.length - shown.length;
  const each = Math.floor(size.rows / shown.length);

  const stacked = shown.flatMap((worker, index) => {
    const height = index === shown.length - 1 ? size.rows - each * (shown.length - 1) : each;
    const pane = hidden > 0 && index === shown.length - 1
      ? { ...worker, subtitle: `+${hidden} hidden` }
      : worker;
    return renderBox(pane, size.cols, height, charset);
  });
  return stacked;
}

/** Returns exactly `height` lines, each exactly `width` characters wide. */
export function renderBox(
  pane: PaneView,
  width: number,
  height: number,
  charset: Charset = "unicode",
): string[] {
  const set = charset === "ascii" ? ASCII : UNICODE;
  const g = pane.focused ? set.focus : set.plain;

  if (width < 4 || height < 2) return Array(Math.max(0, height)).fill(" ".repeat(Math.max(0, width)));

  const inner = width - 4;
  const bodyRows = height - 2;
  const display = pane.lines.flatMap((line) => wrapText(line, inner));

  // scrollOffset counts display lines back from the live tail, so a pane that
  // the user scrolled stays put while new output arrives below it.
  const end = Math.max(0, display.length - pane.scrollOffset);
  const start = Math.max(0, end - bodyRows);
  const window = display.slice(start, end);

  const body = Array.from({ length: bodyRows }, (_row, y) => {
    const text = window[y - (bodyRows - window.length)] ?? "";
    return `${g.v} ${fit(text, inner, g.cut)} ${g.v}`;
  });

  return [
    header(pane, width, g),
    ...body,
    `${g.bl}${g.h.repeat(width - 2)}${g.br}`,
  ];
}

function header(pane: PaneView, width: number, g: Glyphs): string {
  const scroll = pane.scrollOffset > 0 ? ` ${g.up}${pane.scrollOffset}` : "";
  const left = `${g.tl}${g.h} ${pane.title}${scroll} `;
  const right = pane.subtitle ? ` ${pane.subtitle} ${g.h}${g.tr}` : `${g.h}${g.tr}`;
  const fillWidth = width - visible(left) - visible(right);
  if (fillWidth < 0) {
    // No room for the annotation; the title is what identifies the pane.
    return fit(`${g.tl}${g.h} ${pane.title} `, width - 2, g.cut).concat(`${g.h}${g.tr}`);
  }
  return `${left}${g.h.repeat(fillWidth)}${right}`;
}

/** Columns a terminal advances for this text, not characters. */
const visible = displayWidth;

/**
 * Pads or truncates to exactly `width` columns, marking a truncation with
 * `cut`.
 *
 * Measured in columns rather than characters, because a terminal advances two
 * for CJK and for emoji. Truncation stops before a double-width cluster
 * rather than splitting it, which can leave one column spare; that column is
 * padded, so the result is still exactly `width` wide.
 */
export function fit(text: string, width: number, cut = "…"): string {
  if (width <= 0) return "";
  const clean = plain(text).replace(/[\n\t]/g, " ");
  const total = displayWidth(clean);
  if (total === width) return clean;
  if (total < width) return clean + " ".repeat(width - total);

  const cutWidth = displayWidth(cut);
  if (width <= cutWidth) return " ".repeat(width);
  const head = takeColumns(clean, width - cutWidth);
  return `${head.text}${cut}${" ".repeat(width - cutWidth - head.width)}`;
}

/**
 * Strips escape sequences and stray control characters.
 *
 * This is the layout's own guard, not a convenience: agent output is arbitrary
 * text, and an escape sequence both repaints parts of the screen Maya did not
 * draw and counts toward a line's length while occupying no columns, which
 * would silently mis-size every pane on the row.
 */
/* eslint-disable no-control-regex -- matching terminal control characters
   is the point here: this is what strips them out of agent output. */
function plain(text: string): string {
  return (
    text
      // OSC (window title and friends), terminated by BEL or ST.
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\u005c)?/g, "")
      // CSI and the other two- and three-character sequences.
      .replace(/\u001b[[\]()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-Za-z=><~]/g, "")
      // Anything left, including a lone ESC and a carriage return. Tab and
      // newline survive: callers handle those.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
  );
}

/**
 * Word wrap, falling back to a hard break for anything longer than the pane.
 * Continuation lines are indented so a wrapped sentence reads as one entry —
 * except for the pieces of a hard-broken token, which start at column 0 so a
 * long file path or JSON blob can still be read, and copied, in one piece.
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const source = plain(text).replace(/\t/g, "  ");
  if (source === "") return [""];

  const out: string[] = [];
  for (const paragraph of source.split("\n")) {
    if (paragraph === "") {
      out.push("");
      continue;
    }

    const indent = width > 4 ? "  " : "";
    let line = "";
    const flush = (): void => {
      if (line !== "" && line !== indent) out.push(line);
      line = indent;
    };

    for (const word of paragraph.split(/ +/)) {
      if (word === "") continue;

      const candidate = line === "" || line === indent ? `${line}${word}` : `${line} ${word}`;
      if (visible(candidate) <= width) {
        line = candidate;
        continue;
      }

      flush();
      if (visible(`${indent}${word}`) <= width) {
        line = `${indent}${word}`;
        continue;
      }

      // Break by columns so a double-width cluster is never split in half.
      let rest = word;
      while (visible(rest) > width) {
        const piece = takeColumns(rest, width);
        if (piece.text === "") break;
        out.push(piece.text);
        rest = piece.rest;
      }
      line = rest;
    }

    if (line !== "" && line !== indent) out.push(line);
  }
  return out.length > 0 ? out : [""];
}
