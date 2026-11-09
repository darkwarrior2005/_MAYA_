import { watch, type FSWatcher } from "node:fs";
import { sep } from "node:path";

/** Collapses a burst of saves — or a build writing a directory — into one signal. */
const DEBOUNCE_MS = 300;

/** Directories whose churn is not the project the user is looking at. */
const IGNORED = [".git", ".maya", "node_modules", "dist", ".tsbuild"];

export interface FileWatcherOptions {
  repoRoot: string;
  onChange: () => void;
  /** Reported rather than thrown: a missing watcher is not a fatal condition. */
  onUnsupported?: (reason: string) => void;
}

/**
 * Tells the web client when the repository tree has changed.
 *
 * Uses `fs.watch` with `recursive: true` rather than a watcher library, because
 * all that is needed is "something changed" — no per-file events, no globs, no
 * ordering. Recursive watching works on Windows and macOS, and on Linux from
 * Node 20.13. Where it is unavailable the watcher reports that and stays off;
 * the client still has a refresh of its own, so the tree is stale rather than
 * broken.
 */
export class FileWatcher {
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly options: FileWatcherOptions) {}

  get active(): boolean {
    return this.watcher !== undefined;
  }

  start(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(
        this.options.repoRoot,
        { recursive: true, persistent: false },
        (_event, filename) => {
          if (filename && isIgnored(String(filename))) return;
          this.schedule();
        },
      );
      // A watcher error (a watched directory being deleted, a handle limit)
      // must not take the daemon down with it.
      this.watcher.on("error", (error) => {
        this.options.onUnsupported?.(error.message);
        this.stop();
      });
    } catch (error) {
      this.options.onUnsupported?.(error instanceof Error ? error.message : String(error));
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.watcher?.close();
    this.watcher = undefined;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.options.onChange();
    }, DEBOUNCE_MS);
    this.timer.unref();
  }
}

function isIgnored(filename: string): boolean {
  const segments = filename.split(/[\\/]/);
  return segments.some((segment) => IGNORED.includes(segment)) || segments.includes(`.${sep}`);
}
