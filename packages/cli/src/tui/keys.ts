export type KeyName =
  | "enter"
  | "backspace"
  | "tab"
  | "shift-tab"
  | "up"
  | "down"
  | "page-up"
  | "page-down"
  | "home"
  | "end"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-l"
  | "ctrl-u"
  | "escape"
  | "char";

export interface Key {
  name: KeyName;
  /** Present for `char`: the printable text typed. */
  text?: string;
}

const SEQUENCES: Record<string, KeyName> = {
  "\u001b[A": "up",
  "\u001b[B": "down",
  "\u001b[5~": "page-up",
  "\u001b[6~": "page-down",
  "\u001b[H": "home",
  "\u001b[F": "end",
  "\u001b[1~": "home",
  "\u001b[4~": "end",
  "\u001bOA": "up",
  "\u001bOB": "down",
  "\u001bOH": "home",
  "\u001bOF": "end",
  "\u001b[Z": "shift-tab",
};

/**
 * Raw-mode stdin delivers whole escape sequences, pasted text and single
 * characters through the same `data` event, so one chunk can hold several
 * keys. Decoding the chunk as a list keeps a fast typist's keystrokes from
 * being dropped, and keeps a pasted multi-line prompt from being read as a
 * burst of Enters.
 */
export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let index = 0;
  let pending = "";

  const flush = (): void => {
    if (pending === "") return;
    keys.push({ name: "char", text: pending });
    pending = "";
  };

  while (index < chunk.length) {
    const rest = chunk.slice(index);

    const sequence = Object.keys(SEQUENCES).find((candidate) => rest.startsWith(candidate));
    if (sequence) {
      flush();
      keys.push({ name: SEQUENCES[sequence] as KeyName });
      index += sequence.length;
      continue;
    }

    const char = chunk[index] as string;
    const control = controlKey(char);
    if (control) {
      flush();
      keys.push({ name: control });
      index += 1;
      continue;
    }

    // Anything else printable, including whole pasted runs, accumulates so a
    // paste becomes one insertion rather than one key per character.
    if (char >= " " && char !== "\u007f") pending += char;
    index += 1;
  }

  flush();
  return keys;
}

function controlKey(char: string): KeyName | undefined {
  switch (char) {
    case "\r":
    case "\n":
      return "enter";
    case "\u007f":
    case "\b":
      return "backspace";
    case "\t":
      return "tab";
    case "\u0003":
      return "ctrl-c";
    case "\u0004":
      return "ctrl-d";
    case "\u000c":
      return "ctrl-l";
    case "\u0015":
      return "ctrl-u";
    case "\u001b":
      return "escape";
    default:
      return undefined;
  }
}
