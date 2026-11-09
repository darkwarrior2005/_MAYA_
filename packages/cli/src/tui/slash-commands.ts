export interface SlashContext {
  /** Where the daemon is listening, e.g. http://127.0.0.1:51234. */
  daemonAddress: string;
  /** Writes a line into the Operator pane. */
  note: (text: string) => void;
  focus: (index: number) => void;
  paneTitles: string[];
  quit: () => void;
  /** Returns false when no browser was launched, e.g. over SSH. */
  openBrowser: (url: string) => Promise<boolean>;
}

export const SLASH_HELP = [
  "/localhost        open the web interface for this session in a browser",
  "/panes            list the panes and their numbers",
  "/focus <n>        focus pane n (or Tab / Shift-Tab)",
  "/clear            clear the focused pane",
  "/help             this list",
  "/quit             leave the pane view",
];

export function isSlashCommand(line: string): boolean {
  return line.trimStart().startsWith("/");
}

/**
 * Slash commands are Maya's, never the agent's. `/localhost` in particular is
 * intercepted here and must never reach a worker: an agent handed "/localhost"
 * as a prompt would try to interpret it as a task.
 *
 * Returns false for an unrecognized command so the caller can say so rather
 * than quietly forwarding something that looks like a command to an agent.
 */
export async function runSlashCommand(
  line: string,
  context: SlashContext,
  clearFocused: () => void,
): Promise<boolean> {
  const [word = "", ...rest] = line.trim().slice(1).split(/\s+/);
  const command = word.toLowerCase();

  switch (command) {
    case "localhost":
    case "web":
    case "ui": {
      const url = context.daemonAddress;
      try {
        const launched = await context.openBrowser(url);
        context.note(launched ? `opening ${url}` : `open ${url} yourself`);
      } catch (error) {
        context.note(
          `could not open a browser (${error instanceof Error ? error.message : String(error)}) — open ${url} yourself`,
        );
      }
      return true;
    }

    case "panes":
      context.paneTitles.forEach((title, index) => context.note(`  ${index}  ${title}`));
      return true;

    case "focus": {
      const index = Number(rest[0]);
      if (!Number.isInteger(index) || index < 0 || index >= context.paneTitles.length) {
        context.note(`/focus takes a pane number between 0 and ${context.paneTitles.length - 1}`);
        return true;
      }
      context.focus(index);
      return true;
    }

    case "clear":
      clearFocused();
      return true;

    case "help":
    case "?":
      SLASH_HELP.forEach((entry) => context.note(entry));
      return true;

    case "quit":
    case "exit":
    case "q":
      context.quit();
      return true;

    default:
      context.note(`unknown command /${command} — try /help`);
      return false;
  }
}
