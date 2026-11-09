import { useState, type ReactElement } from "react";
import type { FileNode, RepoTree } from "@maya/shared-types";

export function FileBrowser({
  tree,
  selected,
  onSelect,
}: {
  tree: RepoTree;
  selected: string | null;
  onSelect: (path: string) => void;
}): ReactElement {
  const children = tree.root.children ?? [];
  if (children.length === 0) return <p className="empty">Nothing in this repository yet.</p>;

  return (
    <ul className="files" role="tree">
      {children.map((child) => (
        <Entry key={child.path} node={child} depth={0} selected={selected} onSelect={onSelect} />
      ))}
    </ul>
  );
}

function Entry({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
}): ReactElement {
  // Top-level directories start open; deeper ones would bury the tree.
  const [open, setOpen] = useState(depth === 0);

  if (node.type === "file") {
    return (
      <li role="treeitem" aria-selected={selected === node.path}>
        <button
          type="button"
          className={`entry file${selected === node.path ? " selected" : ""}`}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => onSelect(node.path)}
        >
          <span className="glyph" aria-hidden="true" />
          {node.name}
        </button>
      </li>
    );
  }

  const children = node.children ?? [];
  return (
    <li role="treeitem" aria-expanded={open}>
      <button
        type="button"
        className="entry dir"
        style={{ paddingLeft: 10 + depth * 14 }}
        onClick={() => setOpen((current) => !current)}
      >
        <span className={`caret${open ? " open" : ""}`} aria-hidden="true">
          ›
        </span>
        {node.name}
        <span className="count">{children.length}</span>
      </button>
      {open && (
        <ul role="group">
          {children.map((child) => (
            <Entry
              key={child.path}
              node={child}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
