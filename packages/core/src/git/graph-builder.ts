import type { SimpleGit } from "simple-git";
import type { GitGraph, GitNode } from "@maya/shared-types";

/** Unit separator: will not appear in a subject or a ref name. */
const SEP = "\u001f";

const FORMAT = ["%H", "%P", "%s", "%an", "%aI", "%D"].join(SEP);

export interface GraphOptions {
  /** How many commits to walk back. The web client draws all of them. */
  limit?: number;
}

export const DEFAULT_GRAPH_LIMIT = 300;

/**
 * Turns the commit DAG into nodes with lanes assigned, so the client only has
 * to draw what it is given. Lanes are computed here and not in the browser
 * because the same layout has to be reachable from the CLI and from tests.
 *
 * `--topo-order` matches what `git log --graph` shows: it keeps a branch's
 * commits together instead of interleaving branches by date, which is what
 * makes the lanes readable.
 */
export async function buildGraph(git: SimpleGit, options: GraphOptions = {}): Promise<GitGraph> {
  const limit = options.limit ?? DEFAULT_GRAPH_LIMIT;

  const raw = await git.raw([
    "log",
    "--all",
    "--parents",
    "--topo-order",
    `--max-count=${limit}`,
    `--pretty=format:${FORMAT}`,
  ]);

  const nodes = assignLanes(raw.split("\n").filter((line) => line.trim() !== "").map(parseLine));

  return {
    nodes,
    head: await resolveHead(git),
    currentBranch: await resolveBranch(git),
  };
}

interface ParsedCommit {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  date: string;
  refs: string[];
}

function parseLine(line: string): ParsedCommit {
  const [sha = "", parents = "", subject = "", author = "", date = "", refs = ""] =
    line.split(SEP);
  return {
    sha,
    parents: parents.split(" ").filter(Boolean),
    subject,
    author,
    date,
    refs: refs
      .split(",")
      .map((ref) => ref.trim())
      .filter(Boolean),
  };
}

/**
 * Walks the commits in order, keeping one slot per open line of history. A
 * slot holds the sha that line is waiting for; a commit takes the slot that
 * was waiting for it, and its first parent continues in that same slot so a
 * branch stays in one lane for its whole length.
 *
 * Where several slots wait for the same commit, those lines converge: the
 * leftmost keeps going and the rest are freed, which is what a merge looks
 * like. Extra parents of a merge open lines of their own.
 */
export function assignLanes(commits: ParsedCommit[]): GitNode[] {
  const lanes: Array<string | null> = [];

  const firstFree = (): number => {
    const index = lanes.indexOf(null);
    return index === -1 ? lanes.length : index;
  };

  return commits.map((commit) => {
    const waiting = lanes.flatMap((sha, index) => (sha === commit.sha ? [index] : []));

    let lane: number;
    if (waiting.length > 0) {
      lane = waiting[0] as number;
      for (const converged of waiting.slice(1)) lanes[converged] = null;
    } else {
      // A commit nothing is waiting for is the tip of a line of history.
      lane = firstFree();
    }

    lanes[lane] = commit.parents[0] ?? null;
    for (const parent of commit.parents.slice(1)) {
      if (!lanes.includes(parent)) lanes[firstFree()] = parent;
    }

    // Keep the array from growing forever as branches end.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    return { ...commit, lane };
  });
}

async function resolveHead(git: SimpleGit): Promise<string | null> {
  try {
    return (await git.revparse(["HEAD"])).trim();
  } catch {
    // A repository with no commits yet has no HEAD to resolve.
    return null;
  }
}

async function resolveBranch(git: SimpleGit): Promise<string | null> {
  try {
    const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    return branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}
