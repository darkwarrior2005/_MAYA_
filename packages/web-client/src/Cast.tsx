import { useEffect, useState, type ReactElement } from "react";
import type { AgentReport, AgentScorecard, MayaCharacter } from "@maya/shared-types";
import { fetchAgents } from "./api.js";

/**
 * The cast: Maya and the assistants it drives, as animated figures you pick
 * from to read what each is good and bad at.
 *
 * This is the Agents page's content in a different register. The roster at
 * `#/arena` is for comparing: four cards side by side, stat bars, every probe
 * listed. This page is for meeting them one at a time — a figure per
 * assistant, and Maya among them rather than above them, since the thing
 * orchestrating the work has strengths and weaknesses of its own.
 *
 * Both read the same report, so neither can disagree with the other about
 * what was measured.
 */
export function Cast(): ReactElement {
  const [report, setReport] = useState<AgentReport | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string>("maya");

  useEffect(() => {
    void fetchAgents()
      .then((next) => {
        setReport(next);
        setProblem(null);
      })
      .catch((error: unknown) => {
        setProblem(error instanceof Error ? error.message : String(error));
      });
  }, []);

  if (problem) {
    return (
      <div className="cast-empty">
        <h2>Nobody to introduce yet</h2>
        <p>{problem}</p>
        <p className="muted">
          Run <code>maya agents</code> to see what is installed. Add <code>--live</code> to have
          each assistant do a real task — that spends money.
        </p>
      </div>
    );
  }

  if (!report) return <div className="cast-empty">Gathering the cast…</div>;

  // Maya first, then the assistants in the order the report lists them, so
  // the thing you are running is the one you meet first.
  const members: Member[] = [
    fromMaya(report.maya),
    ...report.agents.map((agent) => fromAgent(agent, report.live)),
  ];
  const current = members.find((member) => member.id === chosen) ?? members[0];

  return (
    <div className="cast">
      <header className="cast-head">
        <h2>The cast</h2>
        <p className="muted">
          {report.live
            ? "What each one is like, measured by giving it a real task."
            : "Static checks only — run `maya agents --live` to have them actually do something."}{" "}
          Pick a figure to read its strengths and weaknesses.
        </p>
      </header>

      <div className="stage" role="tablist" aria-label="The cast">
        {members.map((member, index) => (
          <Figure
            key={member.id}
            member={member}
            index={index}
            chosen={member.id === current?.id}
            onChoose={() => setChosen(member.id)}
          />
        ))}
      </div>

      {current && <Dossier member={current} />}
    </div>
  );
}

/**
 * One of the cast, flattened so the figure and the dossier do not each need
 * to know whether they are looking at Maya or at an assistant.
 *
 * `state` drives the animation as well as the label: a figure whose tool is
 * not installed should look absent rather than merely be labelled that way.
 */
interface Member {
  id: string;
  name: string;
  tagline: string;
  pros: string[];
  cons: string[];
  state: "host" | "ready" | "locked" | "absent";
  /** Only assistants have these; Maya has nothing measured to show. */
  stats?: { label: string; value: number; measured: boolean }[];
  note?: string;
}

function fromMaya(maya: MayaCharacter): Member {
  return {
    id: "maya",
    name: maya.displayName,
    tagline: maya.tagline,
    pros: maya.pros,
    cons: maya.cons,
    state: "host",
    // Said plainly rather than shown as empty bars: there is no run of Maya
    // to measure, and a made-up score here would be the one unmeasured
    // number on a page whose point is that the numbers are measured.
    note: "Maya has no stat bars: every figure on an assistant's card came from running that assistant, and there is no equivalent run of the host to put beside them.",
  };
}

function fromAgent(agent: AgentScorecard, live: boolean): Member {
  const measured = (id: string): boolean => {
    const probe = agent.probes.find((candidate) => candidate.id === id);
    return probe !== undefined && probe.outcome !== "skipped";
  };

  return {
    id: agent.tool,
    name: agent.displayName,
    tagline: agent.tagline,
    pros: agent.pros,
    cons: agent.cons,
    state: !agent.installed ? "absent" : !agent.authenticated ? "locked" : "ready",
    stats: [
      { label: "Speed", value: agent.stats.speed, measured: live && measured("speed") },
      { label: "Reliability", value: agent.stats.reliability, measured: true },
      { label: "Autonomy", value: agent.stats.autonomy, measured: true },
      { label: "Thrift", value: agent.stats.thrift, measured: live && measured("reports-cost") },
    ],
    ...(agent.resolvedPath ? { note: `Runs ${agent.resolvedPath}` } : {}),
  };
}

const LABELS: Record<Member["state"], string> = {
  host: "the one in charge",
  ready: "ready",
  locked: "not logged in",
  absent: "not installed",
};

function Figure({
  member,
  index,
  chosen,
  onChoose,
}: {
  member: Member;
  index: number;
  chosen: boolean;
  onChoose: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={chosen}
      className={`figure figure-${member.state}${chosen ? " chosen" : ""}`}
      // Staggered so they do not all bob in unison, which reads as one
      // object rather than several.
      style={{ animationDelay: `${index * 320}ms` }}
      onClick={onChoose}
    >
      <Puppet id={member.id} />
      <span className="figure-name">{member.name}</span>
      <span className="figure-state">{LABELS[member.state]}</span>
    </button>
  );
}

/**
 * The figures themselves, drawn rather than imported.
 *
 * Inline SVG with no external file and no icon dependency: the artifact is
 * served by the daemon offline, and a missing asset would leave a page of
 * empty boxes. Each silhouette carries the sigil the roster already uses for
 * that tool, so the two pages are recognisably about the same four.
 *
 * `currentColor` throughout, so a figure takes its colour from the theme and
 * from its own state class rather than carrying hardcoded light-mode values.
 */
function Puppet({ id }: { id: string }): ReactElement {
  return (
    <svg className="puppet" viewBox="0 0 80 110" aria-hidden="true" focusable="false">
      {/* The ground each one stands on, which the shadow animation tracks. */}
      <ellipse className="puppet-shadow" cx="40" cy="103" rx="17" ry="4" />
      <g className="puppet-body">
        {id === "maya" ? <MayaShape /> : <AgentShape id={id} />}
      </g>
    </svg>
  );
}

/** Maya: a conductor, with one satellite per assistant it can call on. */
function MayaShape(): ReactElement {
  return (
    <>
      <g className="orbit">
        <circle cx="40" cy="44" r="30" className="orbit-ring" />
        <path d="M40 14 l4 7 -4 7 -4 -7z" className="orbit-mark" />
        <path d="M70 44 l7 4 -7 4 -4 -4z" className="orbit-mark" />
        <path d="M40 74 l5 6 -5 6 -5 -6z" className="orbit-mark" />
        <circle cx="10" cy="44" r="4" className="orbit-mark" />
      </g>
      <path d="M40 24 l11 12 -11 12 -11 -12z" className="core" />
      <path d="M40 50 v26" className="spine" />
      <path d="M26 60 h28" className="arms" />
      <path d="M40 76 l-9 20 M40 76 l9 20" className="legs" />
    </>
  );
}

/** The four assistants, each built around its own sigil. */
function AgentShape({ id }: { id: string }): ReactElement {
  const head =
    id === "claude-code" ? (
      <path d="M40 18 l13 14 -13 14 -13 -14z" className="core" />
    ) : id === "copilot-cli" ? (
      <path d="M40 16 l5 11 11 5 -11 5 -5 11 -5 -11 -11 -5 11 -5z" className="core" />
    ) : id === "antigravity-cli" ? (
      <path d="M40 16 l15 27 -30 0z" className="core" />
    ) : (
      <>
        <circle cx="40" cy="32" r="14" className="core" />
        <circle cx="40" cy="32" r="6" className="core-inner" />
      </>
    );

  return (
    <>
      {head}
      <path d="M40 48 v28" className="spine" />
      <path d="M27 58 h26" className="arms" />
      <path d="M40 76 l-9 20 M40 76 l9 20" className="legs" />
    </>
  );
}

function Dossier({ member }: { member: Member }): ReactElement {
  return (
    <section className="dossier" aria-live="polite">
      <header>
        <h3>{member.name}</h3>
        <p className="tagline">{member.tagline}</p>
      </header>

      {member.stats && (
        <dl className="cast-stats">
          {member.stats.map((stat) => (
            <div key={stat.label} className={stat.measured ? "" : "unmeasured"}>
              <dt>{stat.label}</dt>
              <dd>
                <span className="bar">
                  <span className="fill" style={{ width: `${stat.value}%` }} />
                </span>
                {/* An unmeasured bar says so instead of letting the
                    midpoint read as a measurement. */}
                <em>{stat.measured ? stat.value : "not measured"}</em>
              </dd>
            </div>
          ))}
        </dl>
      )}

      {member.note && <p className="cast-note muted">{member.note}</p>}

      <div className="sides">
        <div className="side pros">
          <h4>What it is good at</h4>
          <ul>
            {member.pros.map((pro) => (
              <li key={pro}>{pro}</li>
            ))}
          </ul>
        </div>
        <div className="side cons">
          <h4>What it is bad at</h4>
          <ul>
            {member.cons.length > 0 ? (
              member.cons.map((con) => <li key={con}>{con}</li>)
            ) : (
              <li className="muted">Nothing recorded.</li>
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}
