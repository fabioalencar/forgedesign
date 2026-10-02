// Feedback from wherever a stakeholder already talks (TASK-463, DDR-124).
//
// Cloud is one source of comments; Figma files and issue trackers are others,
// and the triage flow does not care where a comment came from once it is
// staged. An importer reads what those tools export — a file on disk, or the
// tool's own API with the creator's own token, on the creator's own machine —
// and writes the same `.forge/triage/<batch>/comments.json` `forge comments
// triage` writes, plus a `batch.json` saying where the batch came from. Then it
// stops: nothing reaches the record until `forge comments triage apply`, which
// reads the manifest and knows there is no service to mark fetched.

import { promises as fs } from "node:fs";
import path from "node:path";
import { scanBundle } from "@forgedesign/format";
import { bundleRootOf } from "./bundle-index.js";
import type { ApiComment } from "./comments-client.js";
import { todayIsoDate } from "./freezes.js";

/** Where an imported batch came from — the feedback `source` it will carry. */
export type ImportSource = "figma" | "issue";

export const BATCH_FILE = "batch.json";

/**
 * The manifest beside an imported batch's `comments.json`. Its presence is
 * what tells `triage apply` this batch has no snapshot behind it.
 */
export interface ImportedBatch {
  source: ImportSource;
  /** the file key, repository or path the comments were read from */
  origin: string;
  imported_at: string;
  /** the freeze tag the review was about, when the creator names one */
  freeze?: string;
}

export async function readImportedBatch(
  root: string,
  batch: string,
): Promise<ImportedBatch | null> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(root, ".forge", "triage", batch, BATCH_FILE), "utf8"),
    ) as Partial<ImportedBatch>;
    if (parsed.source !== "figma" && parsed.source !== "issue") return null;
    return {
      source: parsed.source,
      origin: typeof parsed.origin === "string" ? parsed.origin : "",
      imported_at: typeof parsed.imported_at === "string" ? parsed.imported_at : "",
      ...(typeof parsed.freeze === "string" ? { freeze: parsed.freeze } : {}),
    };
  } catch {
    return null;
  }
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

// --- Figma ---------------------------------------------------------------------

/** `https://www.figma.com/design/<key>/…` or `…/file/<key>/…` → the key; a bare key passes through. */
export function figmaFileKey(input: string): string {
  const match = /figma\.com\/(?:file|design|board)\/([A-Za-z0-9]+)/.exec(input);
  return match?.[1] ?? input.trim();
}

/**
 * Figma's `GET /v1/files/:key/comments` payload, as the API returns it and as
 * a creator saves it with curl. Resolved comments are left out unless asked
 * for: a comment somebody already resolved in Figma is not waiting on triage.
 */
export function figmaComments(
  payload: unknown,
  options: { fileKey?: string; includeResolved?: boolean } = {},
): { comments: ApiComment[]; resolved: number } {
  const list = (payload as { comments?: unknown })?.comments;
  if (!Array.isArray(list)) {
    throw new Error('not a Figma comments export — expected { "comments": [ … ] }');
  }
  const comments: ApiComment[] = [];
  let resolved = 0;
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const c = raw as Record<string, unknown>;
    const id = asString(c.id);
    const message = asString(c.message);
    if (!id || !message) continue;
    if (asString(c.resolved_at) && !options.includeResolved) {
      resolved += 1;
      continue;
    }
    const fileKey = asString(c.file_key) ?? options.fileKey ?? null;
    const meta = (c.client_meta ?? {}) as Record<string, unknown>;
    const nodeId = asString(meta.node_id);
    const url = fileKey
      ? `https://www.figma.com/file/${fileKey}?${nodeId ? `node-id=${encodeURIComponent(nodeId)}&` : ""}comment=${encodeURIComponent(id)}`
      : null;
    comments.push({
      id,
      parent_id: asString(c.parent_id),
      author_label: asString((c.user as Record<string, unknown> | undefined)?.handle) ?? "Unknown",
      body: message,
      route: null,
      selector: null,
      viewport_w: null,
      viewport_h: null,
      screenshot_url: null,
      url,
      created_at: asString(c.created_at) ?? "",
    });
  }
  return { comments, resolved };
}

// --- GitHub issues --------------------------------------------------------------

/** `owner/repo`, or a github.com URL → `owner/repo`. */
export function githubRepo(input: string): string {
  const match = /github\.com\/([^/\s]+\/[^/\s#?]+)/.exec(input);
  return (match?.[1] ?? input.trim()).replace(/\.git$/, "");
}

/**
 * GitHub issues as the REST API lists them, as `gh issue list --json` prints
 * them, or as the search API wraps them. Pull requests come back on the same
 * endpoint and are not feedback; closed issues are left out unless asked for.
 */
export function githubIssues(
  payload: unknown,
  options: { includeClosed?: boolean } = {},
): { comments: ApiComment[]; closed: number; pullRequests: number } {
  const wrapped = payload as { items?: unknown; issues?: unknown };
  const list = Array.isArray(payload) ? payload : (wrapped?.items ?? wrapped?.issues);
  if (!Array.isArray(list)) {
    throw new Error("not a GitHub issues export — expected an array of issues");
  }
  const comments: ApiComment[] = [];
  let closed = 0;
  let pullRequests = 0;
  for (const raw of list) {
    if (typeof raw !== "object" || raw === null) continue;
    const issue = raw as Record<string, unknown>;
    if (issue.pull_request !== undefined) {
      pullRequests += 1;
      continue;
    }
    const number = typeof issue.number === "number" ? issue.number : null;
    const title = asString(issue.title);
    if (number === null || !title) continue;
    const state = asString(issue.state)?.toLowerCase();
    if (state && state !== "open" && !options.includeClosed) {
      closed += 1;
      continue;
    }
    const body = asString(issue.body);
    const user = (issue.user ?? issue.author ?? {}) as Record<string, unknown>;
    comments.push({
      id: String(number),
      parent_id: null,
      author_label: asString(user.login) ?? "Unknown",
      body: body ? `${title}\n\n${body}` : title,
      route: null,
      selector: null,
      viewport_w: null,
      viewport_h: null,
      screenshot_url: null,
      url: asString(issue.html_url) ?? asString(issue.url),
      created_at: asString(issue.created_at) ?? asString(issue.createdAt) ?? "",
    });
  }
  return { comments, closed, pullRequests };
}

// --- reading the input ------------------------------------------------------------

async function readJsonFile(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${file} is not valid JSON (${(error as Error).message})`);
  }
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  what: string,
): Promise<unknown> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${what} answered ${res.status} for ${url}`);
  return (await res.json()) as unknown;
}

/**
 * The creator's own token, read from the environment on the creator's own
 * machine and sent to the tool it belongs to — nowhere else (design/brief.md's
 * "credentials never leave the machine" is about exactly this).
 */
async function loadFigma(
  input: string,
): Promise<{ payload: unknown; origin: string; fileKey: string | undefined }> {
  const fromFile = await readJsonFile(input);
  if (fromFile !== null) return { payload: fromFile, origin: input, fileKey: undefined };
  const key = figmaFileKey(input);
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    throw new Error(
      `${input} is not a file, so it is read as a Figma file key — set FIGMA_TOKEN to fetch it, ` +
        "or save the comments first: curl -H 'X-Figma-Token: …' https://api.figma.com/v1/files/<key>/comments > comments.json",
    );
  }
  const base = (process.env.FIGMA_API_URL ?? "https://api.figma.com").replace(/\/$/, "");
  const payload = await fetchJson(
    `${base}/v1/files/${encodeURIComponent(key)}/comments`,
    { "X-Figma-Token": token },
    "Figma",
  );
  return { payload, origin: key, fileKey: key };
}

async function loadGithub(input: string): Promise<{ payload: unknown; origin: string }> {
  const fromFile = await readJsonFile(input);
  if (fromFile !== null) return { payload: fromFile, origin: input };
  const repo = githubRepo(input);
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`${input} is neither a file nor an owner/repo`);
  }
  const base = (process.env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/$/, "");
  const token = process.env.GITHUB_TOKEN;
  const payload = await fetchJson(
    `${base}/repos/${repo}/issues?state=open&per_page=100`,
    {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    "GitHub",
  );
  return { payload, origin: repo };
}

// --- staging ---------------------------------------------------------------------------

export interface ImportOptions {
  root: string;
  source: ImportSource;
  /** a saved export on disk, or the file key / repository to fetch */
  input: string;
  /** the batch name under `.forge/triage/`; defaults to `<source>-<today>` */
  batch?: string;
  /** the freeze the review was about, for `freeze:` on the feedback */
  freeze?: string;
  /** Figma: keep comments resolved there; GitHub: keep closed issues */
  includeSettled?: boolean;
  log?: (line: string) => void;
}

export interface ImportResult {
  /** repo-relative path to the staged comments, or null when nothing was staged */
  staged: string | null;
  batch: string;
  count: number;
  /** what was read and not staged, and why */
  skipped: { settled: number; pullRequests: number; alreadyInRecord: number };
}

/** Every `url` a feedback concept already carries — what a re-import must not stage twice. */
async function urlsInRecord(root: string): Promise<Set<string>> {
  const recordRoot = await bundleRootOf(root);
  if (recordRoot === null) return new Set();
  const bundle = await scanBundle(root, { recordRoot });
  return new Set(
    bundle.concepts.flatMap((concept) => {
      const url = concept.type === "Feedback" ? concept.frontmatter.url : undefined;
      return typeof url === "string" ? [url] : [];
    }),
  );
}

export async function stageImport(options: ImportOptions): Promise<ImportResult> {
  const log = options.log ?? (() => {});
  const batch =
    options.batch?.trim() || `${options.source === "issue" ? "issues" : "figma"}-${todayIsoDate()}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(batch)) {
    throw new Error(`"${batch}" is not a batch name — letters, digits, dots, dashes`);
  }
  const dir = path.join(options.root, ".forge", "triage", batch);
  const commentsPath = path.join(dir, "comments.json");
  try {
    await fs.access(commentsPath);
    throw new Error(
      `.forge/triage/${batch}/ already holds a staged batch — apply it with \`forge comments triage apply ${batch}\`, or pick another name with --as`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  let comments: ApiComment[];
  let origin: string;
  const skipped = { settled: 0, pullRequests: 0, alreadyInRecord: 0 };
  if (options.source === "figma") {
    const loaded = await loadFigma(options.input);
    const read = figmaComments(loaded.payload, {
      fileKey: loaded.fileKey,
      includeResolved: options.includeSettled,
    });
    comments = read.comments;
    skipped.settled = read.resolved;
    origin = loaded.origin;
  } else {
    const loaded = await loadGithub(options.input);
    const read = githubIssues(loaded.payload, { includeClosed: options.includeSettled });
    comments = read.comments;
    skipped.settled = read.closed;
    skipped.pullRequests = read.pullRequests;
    origin = loaded.origin;
  }

  // At-least-once, the way a Cloud batch is: the service marks fetched; an
  // import has no service, so the record itself is what says "seen".
  const known = await urlsInRecord(options.root);
  const fresh = comments.filter((comment) => !(comment.url && known.has(comment.url)));
  skipped.alreadyInRecord = comments.length - fresh.length;

  if (fresh.length === 0) {
    log(`Nothing to stage from ${origin}.`);
    return { staged: null, batch, count: 0, skipped };
  }

  const manifest: ImportedBatch = {
    source: options.source,
    origin,
    imported_at: new Date().toISOString(),
    ...(options.freeze ? { freeze: options.freeze } : {}),
  };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(commentsPath, `${JSON.stringify(fresh, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(dir, BATCH_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  log(`Staged ${fresh.length} comment(s) from ${origin} as ${batch}.`);
  return {
    staged: path.join(".forge", "triage", batch, "comments.json"),
    batch,
    count: fresh.length,
    skipped,
  };
}
