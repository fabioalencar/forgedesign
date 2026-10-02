// CLI-side client for the comment API (packages/comments). API-key auth per
// DDR-009. Kept dependency-free: Node's global fetch. Shared with the
// dashboard via the @forgedesign/cli/comments-client export.

import { NOT_SIGNED_IN } from "./cloud-auth.js";
import { readUserConfig } from "./config.js";
import { readFreezes } from "./freezes.js";

export interface CommentsApiConfig {
  apiUrl: string;
  apiKey: string;
}

/**
 * Where `forge comments` talks, and which credential it uses (DDR-104, TASK-420).
 *
 * **Cloud first, because the direct path was never a customer path.**
 * `commentsApiKey` is one deployment-wide secret that authorises every tenant's
 * comments, so a customer could not be given one — which is why every
 * `forge comments` subcommand used to refuse with an instruction no Cloud creator
 * could follow. Going through the control plane uses the `cloudToken` they
 * already have from `forge login`, and the control plane decides ownership,
 * because it is the only plane that knows who owns what.
 *
 * The base URL is the review plane's own paths under `/api/cli`, so nothing in
 * this file changes — only where it points and what it presents.
 *
 * **The direct config survives as an operator and self-host escape hatch**, which
 * is exactly what DDR-104 left it as. It is checked second so that a machine
 * holding both — an operator's, typically — takes the path a customer would,
 * and any breakage shows up on the path that matters rather than hiding behind
 * a credential nobody else has.
 */
export function commentsApiFor(userConfig: {
  cloudApiUrl?: string;
  cloudToken?: string;
  commentsApiUrl?: string;
  commentsApiKey?: string;
}): CommentsApiConfig {
  if (userConfig.cloudToken) {
    const origin = (userConfig.cloudApiUrl ?? "https://useforge.design").replace(/\/$/, "");
    return { apiUrl: `${origin}/api/cli`, apiKey: userConfig.cloudToken };
  }
  if (userConfig.commentsApiUrl && userConfig.commentsApiKey) {
    return { apiUrl: userConfig.commentsApiUrl, apiKey: userConfig.commentsApiKey };
  }
  throw new Error(
    `${NOT_SIGNED_IN}. Feedback from Figma or GitHub issues needs no account: \`forge comments import\`.`,
  );
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
  /**
   * A comment asks for a change; a question asks for an answer (TASK-462).
   * Absent from a service that predates the distinction, which reads as
   * `comment` — what every one of them was. Triage files the two differently.
   */
  kind?: "comment" | "question";
  /**
   * Where the comment lives at its source, for an imported batch (TASK-463):
   * the Figma comment, the GitHub issue. Cloud comments carry none — the
   * service is the source and `id` is the link back.
   */
  url?: string | null;
  route: string | null;
  selector: string | null;
  viewport_w: number | null;
  viewport_h: number | null;
  /** the scenario and flow step the reviewer was on, when guided (T-297) */
  scenario_id?: string | null;
  step_id?: string | null;
  screenshot_url: string | null;
  /**
   * The session the comment was written in, parsed rather than raw (T-426):
   * browser family and major version, OS family, device pixel ratio. Absent
   * on older comments and after the service's retention window; present only
   * on the API-key path, which is this client. Reproduction context for
   * triage — "reviewed on safari 17 / ios" — not part of the record's files.
   */
  ua_family?: string | null;
  ua_version?: string | null;
  os_family?: string | null;
  pixel_ratio?: number | null;
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

/**
 * Sets, extends or clears a round's feedback window (T-387). `null` clears it.
 *
 * Extending is this same call with a later instant, deliberately: a deadline
 * that could only be set once would make a slipped date cost a new freeze, a
 * new URL, and a re-gated audience.
 */
export async function setSnapshotWindow(
  config: CommentsApiConfig,
  snapshotId: string,
  closesAt: string | null,
): Promise<{ closesAt: string | null }> {
  const res = await fetch(url(config, `/snapshots/${snapshotId}/window`), {
    method: "POST",
    headers: authHeaders(config),
    body: JSON.stringify({ closesAt }),
  });
  await expectOk(res, "feedback window");
  const body = (await res.json()) as { closesAt?: string | null };
  return { closesAt: body.closesAt ?? null };
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
  let config: CommentsApiConfig;
  try {
    config = commentsApiFor(await readUserConfig());
  } catch {
    return { kind: "not-configured" };
  }
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
