import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { GitGraph, RepoTree, SessionInfo, TaskSpec, UsageTotals } from "@maya/shared-types";
import {
  fetchConflict,
  fetchFiles,
  fetchGraph,
  fetchSession,
  fetchTasks,
  fetchUsage,
} from "./api.js";
import { Chat } from "./Chat.js";
import { ConflictPrompt } from "./ConflictPrompt.js";
import { FileBrowser } from "./FileBrowser.js";
import { GitTree } from "./GitTree.js";
import { AgentArena } from "./AgentArena.js";
import { Cast } from "./Cast.js";
import { AgentsRoster, AgentsToDo, InfoPanel, SecretChannel } from "./Panels.js";
import { useBus } from "./useBus.js";

/** Which page is showing. Hash routing: no router, no dependency. */
function useRoute(): string {
  const [route, setRoute] = useState(() => window.location.hash.replace(/^#\/?/, "") || "session");
  useEffect(() => {
    const onChange = (): void =>
      setRoute(window.location.hash.replace(/^#\/?/, "") || "session");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function App(): ReactElement {
  const route = useRoute();
  const { events, connection, signals, derived } = useBus();

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [graph, setGraph] = useState<GitGraph | null>(null);
  const [files, setFiles] = useState<RepoTree | null>(null);
  const [tasks, setTasks] = useState<TaskSpec[]>([]);
  const [usage, setUsage] = useState<UsageTotals | null>(null);
  const [answerable, setAnswerable] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const report = useCallback(
    (error: unknown) => setProblem(error instanceof Error ? error.message : String(error)),
    [],
  );

  const reloadSession = useCallback(() => {
    void Promise.all([fetchSession(), fetchGraph(), fetchTasks(), fetchConflict()])
      .then(([nextSession, nextGraph, nextTasks, conflict]) => {
        setSession(nextSession);
        setGraph(nextGraph);
        setTasks(nextTasks);
        setAnswerable(conflict.answerable);
        setProblem(null);
      })
      .catch(report);
  }, [report]);

  const reloadFiles = useCallback(() => {
    void fetchFiles().then(setFiles).catch(report);
  }, [report]);

  const reloadUsage = useCallback(() => {
    void fetchUsage().then(setUsage).catch(report);
  }, [report]);

  useEffect(() => {
    reloadSession();
    reloadFiles();
    reloadUsage();
  }, [reloadSession, reloadFiles, reloadUsage]);

  // The graph, the task list and the working tree are state the event log
  // describes but does not contain, so they are re-read when an event says
  // they have moved. The counters are folded in as events arrive rather than
  // rescanned here.
  useEffect(() => {
    if (derived.graphMoved > 0) reloadSession();
  }, [derived.graphMoved, reloadSession]);

  useEffect(() => {
    if (derived.usageMoved > 0) reloadUsage();
  }, [derived.usageMoved, reloadUsage]);

  useEffect(() => {
    if (signals.files_changed > 0) reloadFiles();
  }, [signals.files_changed, reloadFiles]);

  // A question is open until a resolution for it arrives. Both are events, so
  // this survives a reload or a reconnect without asking the daemon what it
  // is waiting on.
  const pending = derived.conflict;

  return (
    <div className="app">
      <header className="top">
        <h1>Maya</h1>
        <span className="repo" title={session?.repoRoot ?? ""}>
          {session ? shorten(session.repoRoot) : "connecting…"}
        </span>
        <nav className="tabs">
          <a className={route === "session" ? "on" : ""} href="#/session">
            Session
          </a>
          <a className={route === "arena" ? "on" : ""} href="#/arena">
            Agents
          </a>
          <a className={route === "cast" ? "on" : ""} href="#/cast">
            Cast
          </a>
        </nav>
        <span className={`conn conn-${connection}`}>{connectionLabel(connection)}</span>
      </header>

      {problem && <p className="banner error">{problem}</p>}

      {route === "arena" && <AgentArena />}
      {route === "cast" && <Cast />}

      {route !== "arena" && route !== "cast" && (
      <>
      <main className="columns">
        <section className="panel panel-tree">
          <div className="panel-head">
            <h2>Git tree</h2>
            <button type="button" className="ghost" onClick={reloadSession}>
              Refresh
            </button>
          </div>
          <div className="status-box">
            <dl>
              <dt>Branch</dt>
              <dd>{session?.branch ?? "—"}</dd>
              <dt>Status</dt>
              <dd>
                {session == null
                  ? "—"
                  : session.clean
                    ? "clean"
                    : `${session.changedFiles ?? 0} changed`}
              </dd>
              <dt>Commits</dt>
              <dd>{graph?.nodes.length ?? 0}</dd>
            </dl>
          </div>
          <div className="panel-body">{graph ? <GitTree graph={graph} /> : <Loading />}</div>
        </section>

        <section className="panel panel-files">
          <div className="panel-head">
            <h2>Repository</h2>
            <span className="muted">{files ? `${files.fileCount} files` : ""}</span>
          </div>
          <div className="panel-body">
            {files ? (
              <FileBrowser tree={files} selected={selected} onSelect={setSelected} />
            ) : (
              <Loading />
            )}
          </div>
          <footer className="panel-foot">{selected ?? "No file selected"}</footer>
        </section>

        <section className="panel panel-chat">
          <div className="panel-head">
            <h2>AI chat</h2>
            <span className="muted">{events.length} events</span>
          </div>
          {pending && <ConflictPrompt pending={pending} answerable={answerable} />}
          <Chat events={events} />
        </section>
      </main>

      <section className="drawer">
        <div className="panel">
          <div className="panel-head">
            <h2>Agents to do</h2>
          </div>
          <div className="panel-body">
            <AgentsToDo tasks={tasks} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Secret channel</h2>
            <span className="muted">direct to you</span>
          </div>
          <div className="panel-body">
            <SecretChannel events={events} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Agents</h2>
          </div>
          <div className="panel-body">
            <AgentsRoster session={session} events={events} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Info</h2>
          </div>
          <div className="panel-body">
            <InfoPanel usage={usage} />
          </div>
        </div>
      </section>
      </>
      )}
    </div>
  );
}

function Loading(): ReactElement {
  return <p className="empty">Loading…</p>;
}

function connectionLabel(connection: string): string {
  if (connection === "open") return "live";
  if (connection === "retrying") return "reconnecting";
  return "connecting";
}

/** Repository paths are long and the interesting end is the last segment. */
function shorten(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}
