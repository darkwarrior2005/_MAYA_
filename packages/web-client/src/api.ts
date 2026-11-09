import type {
  BusEvent,
  ConflictOption,
  GitGraph,
  RepoTree,
  SessionInfo,
  TaskSpec,
  UsageTotals,
} from "@maya/shared-types";

export interface ConflictState {
  /** False when this session answers merge questions in its own terminal. */
  answerable: boolean;
  pending: { question: string; options: ConflictOption[] } | null;
}

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
export const fetchUsage = (): Promise<UsageTotals> => get("/api/usage");
export const fetchConflict = (): Promise<ConflictState> => get("/api/conflict");
export const fetchEvents = (since: number): Promise<BusEvent[]> =>
  get(`/api/events?since=${since}`);

export async function answerConflict(answer: string): Promise<void> {
  const response = await fetch("/api/conflict", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `could not answer (${response.status})`);
  }
}

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
