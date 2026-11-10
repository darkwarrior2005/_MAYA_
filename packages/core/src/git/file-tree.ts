import type { SimpleGit } from "simple-git";
import type { FileNode, RepoTree } from "@maya/shared-types";

export type { FileNode, RepoTree };

/**
 * Lists the repository from git rather than by walking the filesystem.
 *
 * `--cached --others --exclude-standard` is exactly "tracked, plus untracked
 * that is not ignored", in one call. Walking the disk instead would mean
 * reimplementing .gitignore — or, as a shortcut, skipping a hardcoded list of
 * directories and showing the user build output and dependencies they do not
 * consider part of their project.
 */
export async function buildFileTree(git: SimpleGit): Promise<RepoTree> {
  const raw = await git.raw(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  // -z because a path may contain anything except NUL, newlines included, and
  // git would otherwise quote and escape those paths.
  const listed = raw.split("\0").filter((path) => path !== "");

  // `--cached` reads the index, so a file deleted from disk but not yet
  // committed is still listed. Showing it gives the person a tree entry they
  // cannot open.
  const removed = new Set(
    (await git.raw(["ls-files", "--deleted", "-z"])).split("\0").filter((path) => path !== ""),
  );
  const paths = listed.filter((path) => !removed.has(path));

  const root: FileNode = { name: "", path: "", type: "dir", children: [] };
  for (const path of paths) insert(root, path);
  sort(root);

  return { root, fileCount: paths.length };
}

function insert(root: FileNode, path: string): void {
  const segments = path.split("/");
  let node = root;

  for (const [index, segment] of segments.entries()) {
    const isLeaf = index === segments.length - 1;
    const children = (node.children ??= []);
    const childPath = node.path === "" ? segment : `${node.path}/${segment}`;

    let child = children.find((candidate) => candidate.name === segment);
    if (!child) {
      child = isLeaf
        ? { name: segment, path: childPath, type: "file" }
        : { name: segment, path: childPath, type: "dir", children: [] };
      children.push(child);
    }
    node = child;
  }
}

/** Directories first, then files, each alphabetical — as a file browser shows. */
function sort(node: FileNode): void {
  if (!node.children) return;
  node.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of node.children) sort(child);
}
