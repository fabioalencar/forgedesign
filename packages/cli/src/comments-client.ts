// CLI-side client for the comment API (packages/comments). API-key auth per
// DDR-009. Kept dependency-free: Node's global fetch. Shared with the
// dashboard via the @forgedesign/cli/comments-client export.

import { readUserConfig } from "./config.js";
import { readFreezes } from "./freezes.js";

export interface CommentsApiConfig {
  apiUrl: string;
  apiKey: string;
}

function url(config: CommentsApiConfig, pathname: string): string {
  return `${config.apiUrl.replace(/\/$/, "")}${pathname}`;
}

function authHeaders(config: CommentsApiConfig): Record<string, string> {
  return { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };
}

async function expectOk(res: Response, action: string): Promise<void> {
  if (res.ok) return;
  let detail = `${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) detail = `${res.status}: ${body.error}`;
  } catch {
    // non-JSON error body
  }
  throw new Error(`comment API ${action} failed (${detail})`);
}

export async function registerSnapshot(
  config: CommentsApiConfig,
  snapshot: { id: string; projectId: string; tag: string; pin: string; previewUrl: string | null },
): Promise<void> {
  const res = await fetch(url(config, "/snapshots"), {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify(snapshot),
  });
  await expectOk(res, "snapshot registration");
}

export interface ApiComment {
  id: string;
  parent_id: string | null;
  author_label: string;
  body: string;
  route: string | null;
  selector: string | null;
  viewport_w: number | null;
  viewport_h: number | null;
  /** the scenario and flow step the reviewer was on, when guided (T-297) */
  scenario_id?: string | null;
  step_id?: string | null;
  screenshot_url: string | null;
  created_at: string;
}

/** One comment's place in the resolution trail (T-294). */
export interface CommentResolution {
  commentId: string;
  status: "open" | "addressed" | "declined";
  resolvedInTag?: string | null;
  resolvedInUrl?: string | null;
  note?: string | null;
}

/**
 * Projects the record's dispositions onto the comments that caused them, so an
 * old share link says what became of what its reader wrote. The record decides;
 * this only tells the service.
 */
export async function syncResolutions(
  config: CommentsApiConfig,
  snapshotId: string,
  resolutions: CommentResolution[],
): Promise<number> {
  if (resolutions.length === 0) return 0;
  const res = await fetch(url(config, "/comments/resolve"), {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ snapshotId, resolutions }),
  });
  await expectOk(res, "resolution sync");
  return ((await res.json()) as { resolved?: number }).resolved ?? 0;
}

export async function fetchUnfetchedComments(
  config: CommentsApiConfig,
  snapshotId: string,
): Promise<ApiComment[]> {
  const res = await fetch(url(config, `/comments?snapshot=${snapshotId}&unfetched=true`), {
    headers: authHeaders(config),
  });
  await expectOk(res, "comment fetch");
  return ((await res.json()) as { comments: ApiComment[] }).comments;
}

export async function markCommentsFetched(
  config: CommentsApiConfig,
  snapshotId: string,
  commentIds: string[],
): Promise<void> {
  if (commentIds.length === 0) return;
  const res = await fetch(url(config, "/comments/mark-fetched"), {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ snapshotId, commentIds }),
  });
  await expectOk(res, "mark-fetched");
}

export async function archiveSnapshot(
  config: CommentsApiConfig,
  snapshotId: string,
): Promise<{ alreadyArchived: boolean }> {
  const res = await fetch(url(config, `/snapshots/${snapshotId}/archive`), {
    method: "POST",
    headers: authHeaders(config),
  });
  await expectOk(res, "snapshot archive");
  const body = (await res.json()) as { alreadyArchived?: boolean };
  return { alreadyArchived: body.alreadyArchived === true };
}

async function countUnfetchedComments(
  config: CommentsApiConfig,
  snapshotId: string,
  timeoutMs: number,
): Promise<number> {
  const res = await fetch(url(config, `/comments?snapshot=${snapshotId}&unfetched=true`), {
    headers: authHeaders(config),
    signal: AbortSignal.timeout(timeoutMs),
  });
  await expectOk(res, "comment count");
  return ((await res.json()) as { comments: unknown[] }).comments.length;
}

/**
 * Total unfetched comments across a project's registered snapshots (spec §2
 * status / §4 portfolio). Null means "nothing to count": comment API not
 * configured, no registered snapshots, or the API unreachable — callers show
 * n/a rather than a scary zero. Short timeout so status stays snappy.
 */
/**
 * Why there is no number, when there is no number. These were one `null` and
 * one sentence naming all of them at once, so the line could not distinguish
 * "you have not configured this" from "it is configured and nothing has been
 * frozen yet" — which is exactly the question someone has just after setting
 * the key up (TASK-332).
 */
export type UnfetchedCount =
  | { kind: "count"; count: number }
  | { kind: "not-configured" }
  | { kind: "no-snapshots" }
  | { kind: "unreachable" };

export async function projectUnfetchedCount(
  repoRoot: string,
  timeoutMs = 1500,
): Promise<UnfetchedCount> {
  const userConfig = await readUserConfig();
  if (!userConfig.commentsApiUrl || !userConfig.commentsApiKey) return { kind: "not-configured" };
  const config: CommentsApiConfig = {
    apiUrl: userConfig.commentsApiUrl,
    apiKey: userConfig.commentsApiKey,
  };
  const snapshotIds = (await readFreezes(repoRoot))
    .map((f) => f.snapshotId)
    .filter((id): id is string => Boolean(id));
  if (snapshotIds.length === 0) return { kind: "no-snapshots" };
  try {
    const counts = await Promise.all(
      snapshotIds.map((id) => countUnfetchedComments(config, id, timeoutMs)),
    );
    return { kind: "count", count: counts.reduce((sum, n) => sum + n, 0) };
  } catch {
    // a bad key, a wrong URL, or the service being down — indistinguishable
    // from here, but all of them mean "go look", which `null` never said
    return { kind: "unreachable" };
  }
}
