import type { BusEvent, GitGraph, RepoTree, SessionInfo, TaskSpec } from "@maya/shared-types";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: { error?: string; hint?: string }) =>
        [body.error, body.hint].filter(Boolean).join(" — "),
      )
      .catch(() => response.statusText);
    throw new Error(detail || `request to ${path} failed`);
  }
  return (await response.json()) as T;
}

export const fetchSession = (): Promise<SessionInfo> => get("/api/session");
export const fetchGraph = (): Promise<GitGraph> => get("/api/graph");
export const fetchFiles = (): Promise<RepoTree> => get("/api/files");
export const fetchTasks = (): Promise<TaskSpec[]> => get("/api/tasks");
export const fetchEvents = (since: number): Promise<BusEvent[]> =>
  get(`/api/events?since=${since}`);

export async function sendMessage(text: string): Promise<void> {
  const response = await fetch("/api/message", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `could not send (${response.status})`);
  }
}
