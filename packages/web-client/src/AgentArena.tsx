import { useEffect, useState, type ReactElement } from "react";
import type { AgentReport, AgentScorecard, PlatformNote, ProbeResult } from "@maya/shared-types";
import { fetchAgents } from "./api.js";

/**
 * The roster: every agent Maya can drive, as a character sheet.
 *
 * Nothing here is an opinion someone typed in. The stat bars and the
 * "measured here" lines come from `maya agents`, which runs the probes
 * against the tools actually installed on this machine — including, with
 * `--live`, giving each one a real task in a throwaway directory and watching
 * what it does.
 */
export function AgentArena(): ReactElement {
  const [report, setReport] = useState<AgentReport | null>(null);
  const [problem, setProblem] = useState<{ error: string; hint?: string } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    void fetchAgents()
      .then((next) => {
        setReport(next);
        setProblem(null);
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setProblem({ error: message });
      });
  }, []);

  if (problem) {
    return (
      <div className="arena-empty">
        <h2>No scorecards yet</h2>
        <p>{problem.error}</p>
        <p className="muted">
          Run <code>maya agents</code> to test what is installed. Add <code>--live</code> to have
          each agent do a real task — that spends money.
        </p>
      </div>
    );
  }

  if (!report) return <div className="arena-empty">Loading the roster…</div>;

  return (
    <div className="arena">
      <header className="arena-head">
        <div>
          <h2>The roster</h2>
          <p className="muted">
            {report.live
              ? "Measured by giving each agent a real task."
              : "Static checks only — run `maya agents --live` to have them actually do something."}{" "}
            Checked {new Date(report.checkedAt).toLocaleString()}.
          </p>
        </div>
      </header>

      <section className="arena-roster">
        {report.agents.map((agent, index) => (
          <CharacterCard
            key={agent.tool}
            agent={agent}
            index={index}
            open={selected === agent.tool}
            onToggle={() => setSelected(selected === agent.tool ? null : agent.tool)}
          />
        ))}
      </section>

      <Hazards notes={report.platform} />
    </div>
  );
}

const SIGILS: Record<string, string> = {
  "claude-code": "◆",
  "copilot-cli": "✦",
  "antigravity-cli": "▲",
};

function CharacterCard({
  agent,
  index,
  open,
  onToggle,
}: {
  agent: AgentScorecard;
  index: number;
  open: boolean;
  onToggle: () => void;
}): ReactElement {
  const state = !agent.installed ? "absent" : !agent.authenticated ? "locked" : "ready";
  const ran = agent.probes.filter((probe) => probe.outcome !== "skipped");
  const passed = ran.filter((probe) => probe.outcome === "pass").length;

  return (
    <article
      className={`character character-${state}${open ? " open" : ""}`}
      style={{ animationDelay: `${index * 90}ms` }}
    >
      <div className="character-top">
        <div className="sigil" aria-hidden="true">
          <span>{SIGILS[agent.tool] ?? "●"}</span>
        </div>
        <div className="who">
          <h3>{agent.displayName}</h3>
          <p className="tagline">{agent.tagline}</p>
        </div>
        <span className={`badge badge-${state}`}>
          {state === "ready" ? "ready" : state === "locked" ? "not logged in" : "not installed"}
        </span>
      </div>

      <dl className="stats">
        <Stat label="Speed" value={agent.stats.speed} measured={agent.live} />
        <Stat label="Reliability" value={agent.stats.reliability} measured />
        <Stat label="Autonomy" value={agent.stats.autonomy} measured />
        <Stat label="Thrift" value={agent.stats.thrift} measured={agent.live} />
      </dl>

      <div className="sides">
        <div className="side pros">
          <h4>Strengths</h4>
          <ul>
            {agent.pros.map((pro) => (
              <li key={pro}>{pro}</li>
            ))}
          </ul>
        </div>
        <div className="side cons">
          <h4>Weaknesses</h4>
          <ul>
            {agent.cons.length > 0 ? (
              agent.cons.map((con) => <li key={con}>{con}</li>)
            ) : (
              <li className="muted">None found.</li>
            )}
          </ul>
        </div>
      </div>

      <button type="button" className="ghost reveal" onClick={onToggle} aria-expanded={open}>
        {open ? "Hide" : "Show"} the {ran.length} checks ({passed} passed)
      </button>

      {open && (
        <ol className="probes">
          {agent.probes.map((probe) => (
            <ProbeRow key={probe.id} probe={probe} />
          ))}
        </ol>
      )}
    </article>
  );
}

function Stat({
  label,
  value,
  measured,
}: {
  label: string;
  value: number;
  measured: boolean;
}): ReactElement {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>
        <span className="bar" role="img" aria-label={`${label} ${value} of 100`}>
          <span className="fill" style={{ width: `${value}%` }} />
        </span>
        <span className="figure">
          {value}
          {measured ? "" : "?"}
        </span>
      </dd>
    </div>
  );
}

function ProbeRow({ probe }: { probe: ProbeResult }): ReactElement {
  return (
    <li className={`probe probe-${probe.outcome}`}>
      <span className="mark" aria-hidden="true" />
      <div>
        <strong>{probe.title}</strong>
        {probe.live && <span className="live-tag">live</span>}
        <p>{probe.detail}</p>
      </div>
    </li>
  );
}

/** What is wrong with the platform or with Maya, rather than with an agent. */
function Hazards({ notes }: { notes: PlatformNote[] }): ReactElement {
  const areas: Array<{ id: PlatformNote["area"]; title: string; blurb: string }> = [
    { id: "windows", title: "Windows", blurb: "Quirks of the console everything is drawn in." },
    { id: "maya", title: "Maya itself", blurb: "What the application gets wrong, or has not proven." },
    { id: "docs", title: "Documentation", blurb: "What Maya writes down, and what it does not." },
  ];

  return (
    <section className="hazards">
      <h2>The terrain</h2>
      <p className="muted">
        Problems that belong to the platform or to Maya. Each says what is done about it.
      </p>
      <div className="hazard-grid">
        {areas.map((area) => (
          <div key={area.id} className="hazard-column">
            <h3>{area.title}</h3>
            <p className="muted">{area.blurb}</p>
            {notes
              .filter((note) => note.area === area.id)
              .map((note) => (
                <article key={note.id} className={`hazard hazard-${note.severity}`}>
                  <header>
                    <h4>{note.title}</h4>
                    <span className={`sev sev-${note.severity}`}>{note.severity}</span>
                  </header>
                  <p>{note.detail}</p>
                  <p className="mitigation">{note.mitigation}</p>
                </article>
              ))}
          </div>
        ))}
      </div>
    </section>
  );
}
