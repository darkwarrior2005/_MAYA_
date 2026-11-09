import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { GitGraph, RepoTree, SessionInfo } from "@maya/shared-types";
import { fetchFiles, fetchGraph, fetchSession } from "./api.js";
import { Chat } from "./Chat.js";
import { FileBrowser } from "./FileBrowser.js";
import { GitTree } from "./GitTree.js";
import { useBus } from "./useBus.js";

/** Events that mean the commit graph has moved on. */
const GRAPH_CHANGING = new Set(["merge_result", "task_completed", "task_assigned"]);

export function App(): ReactElement {
  const { events, connection, signals } = useBus();

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [graph, setGraph] = useState<GitGraph | null>(null);
  const [files, setFiles] = useState<RepoTree | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const reloadSession = useCallback(() => {
    void Promise.all([fetchSession(), fetchGraph()])
      .then(([nextSession, nextGraph]) => {
        setSession(nextSession);
        setGraph(nextGraph);
        setProblem(null);
      })
      .catch((error: unknown) =>
        setProblem(error instanceof Error ? error.message : String(error)),
      );
  }, []);

  const reloadFiles = useCallback(() => {
    void fetchFiles()
      .then(setFiles)
      .catch((error: unknown) =>
        setProblem(error instanceof Error ? error.message : String(error)),
      );
  }, []);

  useEffect(() => {
    reloadSession();
    reloadFiles();
  }, [reloadSession, reloadFiles]);

  // The graph and the working tree are state the event log describes but does
  // not contain, so they are re-read when an event says they have moved.
  const graphMoved = events.filter((event) => GRAPH_CHANGING.has(event.type)).length;
  useEffect(() => {
    if (graphMoved > 0) reloadSession();
  }, [graphMoved, reloadSession]);

  useEffect(() => {
    if (signals.files_changed > 0) reloadFiles();
  }, [signals.files_changed, reloadFiles]);

  return (
    <div className="app">
      <header className="top">
        <h1>Maya</h1>
        <span className="repo" title={session?.repoRoot ?? ""}>
          {session ? shorten(session.repoRoot) : "connecting…"}
        </span>
        <span className={`conn conn-${connection}`}>{connectionLabel(connection)}</span>
      </header>

      {problem && <p className="banner error">{problem}</p>}

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
              <dt>Workers</dt>
              <dd>{session?.workers.filter((worker) => worker.enabled).length ?? 0} enabled</dd>
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
          <Chat events={events} />
        </section>
      </main>
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
