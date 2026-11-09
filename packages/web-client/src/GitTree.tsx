import type { ReactElement } from "react";
import type { GitGraph, GitNode } from "@maya/shared-types";

const ROW = 30;
const LANE = 16;
const GUTTER = 14;
const DOT = 4.5;

/** One colour per lane, cycled. Lane identity is all it encodes. */
const LANE_COLORS = [
  "var(--lane-0)",
  "var(--lane-1)",
  "var(--lane-2)",
  "var(--lane-3)",
  "var(--lane-4)",
  "var(--lane-5)",
];

interface Placed {
  row: number;
  lane: number;
}

export function GitTree({ graph }: { graph: GitGraph }): ReactElement {
  if (graph.nodes.length === 0) return <p className="empty">No commits yet.</p>;

  const placed = new Map<string, Placed>(
    graph.nodes.map((node, row) => [node.sha, { row, lane: node.lane }]),
  );
  const laneCount = Math.max(...graph.nodes.map((node) => node.lane)) + 1;
  const gutterWidth = GUTTER * 2 + (laneCount - 1) * LANE;
  const height = graph.nodes.length * ROW + ROW / 2;

  return (
    <div className="tree">
      <svg
        className="tree-gutter"
        width={gutterWidth}
        height={height}
        role="presentation"
        style={{ minWidth: gutterWidth, width: gutterWidth }}
      >
        {graph.nodes.flatMap((node) => edges(node, placed, graph.nodes.length))}
        {graph.nodes.map((node, row) => (
          <circle
            key={node.sha}
            cx={x(node.lane)}
            cy={y(row)}
            r={node.sha === graph.head ? DOT + 1.5 : DOT}
            fill={LANE_COLORS[node.lane % LANE_COLORS.length]}
            stroke="var(--panel)"
            strokeWidth={node.sha === graph.head ? 2 : 0}
          />
        ))}
      </svg>

      <ol className="tree-rows">
        {graph.nodes.map((node) => (
          <li key={node.sha} className="tree-row" style={{ height: ROW }}>
            <span className="subject" title={node.subject}>
              {node.subject || "(no message)"}
            </span>
            {node.refs.map((ref) => (
              <span key={ref} className={refClass(ref)} title={ref}>
                {shortRef(ref)}
              </span>
            ))}
            <span className="sha">{node.sha.slice(0, 7)}</span>
            <span className="author">{node.author}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const x = (lane: number): number => GUTTER + lane * LANE;
const y = (row: number): number => row * ROW + ROW / 2;

/**
 * A line from each commit down to each of its parents. Where the lanes differ,
 * the path runs straight down and steps across at the parent's row, which is
 * what makes a branch read as leaving its line and a merge as rejoining one.
 */
function edges(node: GitNode, placed: Map<string, Placed>, total: number): ReactElement[] {
  const self = placed.get(node.sha);
  if (!self) return [];
  const color = LANE_COLORS[node.lane % LANE_COLORS.length] as string;

  return node.parents.flatMap((parent, index) => {
    const target = placed.get(parent);

    if (!target) {
      // The parent is older than the window we fetched. Only the first parent
      // continues the lane, and it trails off rather than stopping dead.
      if (index > 0) return [];
      return [
        <path
          key={`${node.sha}-beyond`}
          d={`M ${x(node.lane)} ${y(self.row)} V ${total * ROW}`}
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray="2 4"
          fill="none"
        />,
      ];
    }

    const from = x(node.lane);
    const to = x(target.lane);
    const d =
      from === to
        ? `M ${from} ${y(self.row)} V ${y(target.row)}`
        : `M ${from} ${y(self.row)} V ${y(target.row) - ROW / 2} Q ${from} ${y(target.row)} ${to} ${y(target.row)}`;

    return [
      <path key={`${node.sha}-${parent}`} d={d} stroke={color} strokeWidth={1.5} fill="none" />,
    ];
  });
}

/**
 * Task branches are `maya/<task>/<agent>`, which is three times the width of
 * the commit subject beside it. The agent is the part that identifies the
 * branch to a reader; the full name stays in the tooltip.
 */
function shortRef(ref: string): string {
  const name = ref.replace("HEAD -> ", "");
  if (!name.startsWith("maya/")) return name;
  const agent = name.split("/").at(-1);
  return agent ? `…/${agent}` : name;
}

function refClass(ref: string): string {
  if (ref.startsWith("HEAD")) return "ref ref-head";
  if (ref.startsWith("tag:")) return "ref ref-tag";
  if (ref.startsWith("maya/")) return "ref ref-task";
  return "ref";
}
