// `forge publish` — send a frozen build to Cloud (DDR-073, DDR-076), and beside
// it the part of the record stakeholders may see (DDR-129).
//
// Two things travel and nothing is injected. The build is what freeze produced,
// byte for byte; Cloud adds the review toolbar at serve time. The record is a
// snapshot the creator chose: every concept whose `audience` is stakeholders
// (DDR-128), read from the tag rather than the working tree, so what Cloud holds
// is what was frozen and not what the repo has moved on to. The repository
// itself stays home.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  audienceOf,
  buildBundleIndex,
  isReservedFilename,
  type ParsedConcept,
  parseConcept,
} from "@forgedesign/format";
import { cloudApiUrl, NOT_SIGNED_IN } from "./cloud-auth.js";
import { readUserConfig } from "./config.js";
import { fileAtRef, git } from "./git.js";

/** Content types the review runtime needs to serve a static prototype correctly. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
};

export function contentTypeFor(relPath: string): string {
  // Guessing wrong here breaks the prototype in the reviewer's browser rather
  // than at publish time, so unknowns fall back to a type browsers download
  // instead of one they might misinterpret.
  return CONTENT_TYPES[path.extname(relPath).toLowerCase()] ?? "application/octet-stream";
}

export interface PublishFile {
  path: string;
  content: string;
  contentType: string;
}

/**
 * Paths that are almost never meant to be published, and dangerous when they
 * are: a `.git` entry means `build.output` points at a repository rather than a
 * build directory, so its whole history would go with it; `node_modules` means a
 * source tree; a `.env` file is secrets. A published freeze is world-readable to
 * anyone with the URL, so any of these leaking is the kind of mistake there is no
 * taking back.
 *
 * The server-side secret scan (TASK-366) is the net against *evasion* — a hostile
 * author who can read the Apache-2.0 source and route around a client check. This
 * is the net against a *mistake*, and for a mistake the CLI is the better place:
 * it fails before uploading the build rather than after, and it can name the file.
 *
 * A denylist of specific hazards, deliberately not "every dotfile": a published
 * static site legitimately carries `.well-known/` and `.nojekyll`.
 */
export function screenPublishHazards(files: PublishFile[]): Array<{ path: string; why: string }> {
  const hazards: Array<{ path: string; why: string }> = [];
  for (const file of files) {
    const segments = file.path.split("/");
    const base = segments.at(-1) ?? "";
    if (segments.includes(".git")) hazards.push({ path: file.path, why: "a git repository" });
    else if (segments.includes("node_modules"))
      hazards.push({ path: file.path, why: "a dependency tree" });
    // `.env.example`/`.sample`/`.template` are placeholder conventions, not secrets.
    else if (base === ".env" || /^\.env\.(?!example$|sample$|template$)/.test(base))
      hazards.push({ path: file.path, why: "an environment file" });
  }
  return hazards;
}

/** The refusal a hazard screen produces — names a few paths and the way past. */
export function hazardRefusal(hazards: Array<{ path: string; why: string }>): string {
  const shown = hazards
    .slice(0, 5)
    .map((h) => `  ${h.path} — looks like part of ${h.why}`)
    .join("\n");
  const more = hazards.length > 5 ? `\n  …and ${hazards.length - 5} more` : "";
  return [
    `refusing to publish ${hazards.length} file(s) that look swept in by mistake:`,
    ``,
    `${shown}${more}`,
    ``,
    `A published freeze is readable by anyone with the URL. Point "build.output" at`,
    `your build directory (e.g. dist/), or re-run with --force to publish anyway.`,
  ].join("\n");
}

/** Every file in a build directory, as the publish payload, paths POSIX-style. */
export async function collectBuild(buildDir: string): Promise<PublishFile[]> {
  const entries = await fs.readdir(buildDir, { recursive: true, withFileTypes: true });
  const files: PublishFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const abs = path.join(entry.parentPath, entry.name);
    const rel = path.relative(buildDir, abs).split(path.sep).join("/");
    files.push({
      path: rel,
      content: (await fs.readFile(abs)).toString("base64"),
      contentType: contentTypeFor(rel),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const MARKDOWN = "text/markdown; charset=utf-8";
/** The scaffold's example decision, never a decision of this project. */
const TEMPLATE_DECISION_ID = "DDR-000";

/** The record as it crosses: what goes, and a count of what stayed for the message. */
export interface RecordSnapshot {
  /** `index.md` regenerated over what crossed, then every concept that did — bundle-relative */
  files: PublishFile[];
  /** concepts whose audience is stakeholders */
  kept: number;
  /** concepts at the tag that stayed home, because their audience is the owner */
  withheld: number;
}

const EMPTY_SNAPSHOT: RecordSnapshot = { files: [], kept: 0, withheld: 0 };

/**
 * The record at a tag, filtered to what stakeholders may see (DDR-128, DDR-129).
 *
 * **Read from the tag, not the working tree.** A freeze is published after it
 * was cut, sometimes long after, and the record keeps moving in between. The
 * snapshot Cloud holds beside `v4`'s build must be the record as it stood at
 * `v4` — the same rule the handoff pack and the feature log already follow — or
 * a stakeholder reads a brief the frozen screens were never built to.
 *
 * **Filtered here, before anything leaves the machine.** `audienceOf` is the one
 * reader of the field, and this is the boundary DDR-128 exists for: a concept
 * that is the owner's never crosses, so nothing downstream — the answering AI,
 * the gate, a feedback page — has to remember to hide it. The bundle's own
 * `index.md` is not sent, because it names every concept including the ones
 * that stayed; one is regenerated over what crossed, so what arrives is still a
 * bundle a consumer can scan. `log.md` stays for the same reason.
 *
 * A tag with no record beneath it — a v0.1 repo, or one from before the record
 * existed — yields an empty snapshot rather than an error: the build still
 * publishes as it always did.
 */
export async function collectRecord(
  root: string,
  tag: string,
  recordRoot: string,
): Promise<RecordSnapshot> {
  let listing: string;
  try {
    listing = await git(root, [
      "ls-tree",
      "-r",
      "--name-only",
      "--end-of-options",
      tag,
      "--",
      recordRoot,
    ]);
  } catch {
    return EMPTY_SNAPSHOT;
  }
  const prefix = `${recordRoot.replace(/\/+$/, "")}/`;
  const paths = listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix) && line.endsWith(".md"))
    .sort();

  const kept: Array<{ concept: ParsedConcept; bytes: Buffer }> = [];
  let withheld = 0;
  for (const repoPath of paths) {
    const rel = repoPath.slice(prefix.length);
    if (isReservedFilename(path.posix.basename(rel))) continue;
    const bytes = await fileAtRef(root, tag, repoPath);
    const concept = parseConcept(rel, bytes.toString("utf8"));
    if (concept.id === TEMPLATE_DECISION_ID) continue;
    if (audienceOf(concept) !== "stakeholders") {
      withheld += 1;
      continue;
    }
    kept.push({ concept, bytes });
  }
  if (kept.length === 0) return { ...EMPTY_SNAPSHOT, withheld };

  const index: PublishFile = {
    path: "index.md",
    content: Buffer.from(buildBundleIndex(kept.map((entry) => entry.concept))).toString("base64"),
    contentType: MARKDOWN,
  };
  const files = kept.map(({ concept, bytes }) => ({
    path: concept.relPath,
    content: bytes.toString("base64"),
    contentType: MARKDOWN,
  }));
  return { files: [index, ...files], kept: kept.length, withheld };
}

export interface PublishResult {
  url: string;
  /**
   * The short form (DDR-085), when the service minted one — what a creator
   * actually sends. Optional because a freeze published before short links
   * existed has none, and because failing to mint one must not fail a publish.
   */
  shortUrl?: string;
  /** the account's namespace (DDR-085); absent from a service that predates it */
  namespace?: string;
  slug: string;
  tag: string;
  fileCount: number;
  /**
   * The snapshot the control plane registered for this freeze (DDR-104).
   * Optional so a service that predates the change still parses.
   */
  snapshotId?: string;
  /**
   * The six digits a stakeholder types (TASK-447, DDR-115).
   *
   * Minted by Cloud now, and shown here once — the CLI never stores it. Optional
   * because a service that predates the change returns no `pin`, in which case
   * the digits are the ones the freeze printed and `freezes.json` still has them.
   */
  pin?: string;
  freezesUsed: number;
  /**
   * How many record files Cloud stored beside the build (DDR-129), the
   * regenerated index included. Absent from a service that predates the
   * crossing — which ignores the field and hosts the build as before.
   */
  recordFileCount?: number;
}

export interface PublishRefusal {
  error: string;
  refusal?: { limit: string; used: number; allowed: number };
  /** files the service thinks carry a secret (TASK-366); present only on that refusal */
  secrets?: Array<{ path: string; what: string }>;
}

/**
 * The most one publish can send (TASK-522).
 *
 * Not Forge's number: the host refuses a function request body over 4.5 MB
 * before the route runs, with its own error text (measured 2026-10-12). Files
 * travel as base64 inside JSON, so this is about 3.3 MB of build and record,
 * far under the 25 MB the service checks. Until publish uploads straight to
 * storage (DDR-153), the CLI says so before the transfer and names what to
 * shrink.
 */
export const PUBLISH_BODY_LIMIT = 4_500_000;

const decodedSize = (file: PublishFile): number => Buffer.byteLength(file.content, "base64");

const megabytes = (bytes: number): string => `${(bytes / 1_000_000).toFixed(1)} MB`;

/**
 * The refusal for a publish too large to send — the size, the limit, and the
 * five largest files, since those are what a creator can actually shrink.
 * `--force` is not offered: the limit is the host's, and nothing gets past it.
 */
export function oversizeRefusal(bodyBytes: number, files: PublishFile[]): string {
  const total = files.reduce((sum, file) => sum + decodedSize(file), 0);
  const largest = [...files]
    .sort((a, b) => decodedSize(b) - decodedSize(a))
    .slice(0, 5)
    .map((file) => `  ${megabytes(decodedSize(file)).padStart(8)}  ${file.path}`)
    .join("\n");
  return [
    `this publish is ${megabytes(bodyBytes)} to send, and Forge Cloud takes at most ${megabytes(PUBLISH_BODY_LIMIT)}`,
    `per publish — about 3.3 MB of files, because they travel encoded. These come to`,
    `${megabytes(total)}; the largest:`,
    ``,
    largest,
    ``,
    `Compress or resize the largest images and video, or host big media elsewhere and`,
    `link to it. --force does not get past this: the limit is the host's, not a check.`,
  ].join("\n");
}

type PublishOutcome = { ok: true; result: PublishResult } | { ok: false; refusal: PublishRefusal };

interface PublishRequest {
  base: string;
  headers: Record<string, string>;
  projectId: string;
  repoName: string;
  tag: string;
  force?: boolean;
  message?: string;
  files: PublishFile[];
  record?: PublishFile[];
}

export async function publishBuild(input: {
  buildDir: string;
  projectId: string;
  repoName: string;
  tag: string;
  /** publish even when the service thinks the build carries a secret (TASK-366) */
  force?: boolean;
  /** the record as `collectRecord` filtered it; omitted when the repo has none */
  record?: RecordSnapshot;
  /** the freeze's message, which Cloud shows beside the version */
  message?: string;
}): Promise<PublishOutcome> {
  const config = await readUserConfig();
  if (!config.cloudToken) {
    return { ok: false, refusal: { error: NOT_SIGNED_IN } };
  }
  const base = await cloudApiUrl();
  const files = await collectBuild(input.buildDir);
  if (files.length === 0) {
    return { ok: false, refusal: { error: `nothing to publish — ${input.buildDir} is empty` } };
  }

  // Before the upload, not after: the whole value of a client-side check on a
  // mistake is that it costs nothing and names the file (TASK-404 finding 4).
  if (input.force !== true) {
    const hazards = screenPublishHazards(files);
    if (hazards.length > 0) return { ok: false, refusal: { error: hazardRefusal(hazards) } };
  }

  const request: PublishRequest = {
    base,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.cloudToken}` },
    projectId: input.projectId,
    repoName: input.repoName,
    tag: input.tag,
    force: input.force,
    message: input.message,
    files,
    record: input.record && input.record.files.length > 0 ? input.record.files : undefined,
  };

  // The server says how it takes a publish (DDR-154): Cloud stages uploads
  // (DDR-153); the website's older route takes one body.
  const me = await fetch(`${base}/api/cli/me`, { headers: request.headers });
  if (me.status === 401) return { ok: false, refusal: { error: NOT_SIGNED_IN } };
  const transport = me.ok
    ? ((await me.json().catch(() => ({}))) as { publish?: unknown }).publish
    : undefined;
  return transport === "staged" ? publishStaged(request) : publishSingleBody(request);
}

/** How many uploads run at once, and how often one is tried before the publish gives up. */
const UPLOAD_CONCURRENCY = 8;
const UPLOAD_ATTEMPTS = 3;

interface PresignedUpload {
  kind: "build" | "record";
  path: string;
  url: string;
  contentType: string;
}

/**
 * A publish as Cloud takes it (DDR-153): declare every file, `PUT` each to the
 * URL Cloud presigned for it, then commit. Cloud checks what arrived against
 * the declaration before anything is published, so a file that fails here
 * fails the publish rather than going out incomplete.
 */
async function publishStaged(request: PublishRequest): Promise<PublishOutcome> {
  const bytes = new Map<string, Buffer>();
  const declare = (kind: "build" | "record") => (file: PublishFile) => {
    const data = Buffer.from(file.content, "base64");
    bytes.set(`${kind}:${file.path}`, data);
    return {
      path: file.path,
      size: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex"),
      contentType: file.contentType,
    };
  };
  const opened = await readOutcome<{ uploadId: string; uploads: PresignedUpload[] }>(
    request.base,
    await fetch(`${request.base}/api/cli/publish`, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({
        projectId: request.projectId,
        repoName: request.repoName,
        tag: request.tag,
        force: request.force === true ? true : undefined,
        message: request.message,
        files: request.files.map(declare("build")),
        // Beside the build, never inside it (DDR-129).
        record: (request.record ?? []).map(declare("record")),
      }),
    }),
  );
  if (!opened.ok) return opened;

  const { uploadId, uploads } = opened.result;
  for (let i = 0; i < uploads.length; i += UPLOAD_CONCURRENCY) {
    const failures = await Promise.all(
      uploads.slice(i, i + UPLOAD_CONCURRENCY).map(async (upload) => {
        const data = bytes.get(`${upload.kind}:${upload.path}`);
        const failure = data
          ? await putWithRetry(upload, data)
          : "Cloud asked for a file this build does not have";
        return failure
          ? `${upload.kind === "record" ? "design/" : ""}${upload.path}: ${failure}`
          : null;
      }),
    );
    const failed = failures.find((failure) => failure !== null);
    if (failed) return { ok: false, refusal: { error: `could not upload ${failed}` } };
  }

  return readOutcome<PublishResult>(
    request.base,
    await fetch(`${request.base}/api/cli/publish/commit`, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify({ uploadId }),
    }),
  );
}

/**
 * One file to its presigned URL, or why not. A `409` means an earlier attempt
 * landed before its answer was lost (the URL refuses overwrites), so it counts
 * as uploaded; commit's hash check decides whether it was right. A network
 * error or a 5xx is tried again; any other refusal is final.
 */
async function putWithRetry(upload: PresignedUpload, data: Buffer): Promise<string | null> {
  let last = "";
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(upload.url, {
        method: "PUT",
        headers: { "Content-Type": upload.contentType },
        body: data,
      });
      if (res.ok || res.status === 409) return null;
      last =
        `HTTP ${res.status} ${(await res.text()).replace(/\s+/g, " ").trim().slice(0, 200)}`.trim();
      if (res.status < 500) return last;
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause);
    }
    if (attempt < UPLOAD_ATTEMPTS)
      await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
  }
  return last;
}

/**
 * A response as a result or a refusal. Read as text first: every refusal the
 * service intends is JSON with an `error`, but an unhandled exception comes back
 * as an HTML page, and parsing that into `{}` printed "forge publish: undefined"
 * (TASK-355).
 */
async function readOutcome<T>(
  base: string,
  res: Response,
  tooLarge?: () => string,
): Promise<{ ok: true; result: T } | { ok: false; refusal: PublishRefusal }> {
  const raw = await res.text();
  let body: (T & PublishRefusal) | undefined;
  try {
    body = JSON.parse(raw) as T & PublishRefusal;
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    if (body && typeof body.error === "string") return { ok: false, refusal: body };
    if (res.status === 413 && tooLarge) return { ok: false, refusal: { error: tooLarge() } };
    // Not a refusal we know how to describe: say what the server did, because
    // a status code and a snippet are what make this reportable.
    const snippet = raw.replace(/\s+/g, " ").trim().slice(0, 300);
    return {
      ok: false,
      refusal: {
        error:
          `${base} returned HTTP ${res.status} ${res.statusText}` +
          (snippet ? ` — ${snippet}` : " with an empty body"),
      },
    };
  }
  if (!body) {
    return {
      ok: false,
      refusal: { error: `${base} returned HTTP ${res.status} with a body that is not JSON` },
    };
  }
  return { ok: true, result: body };
}

/** The website's publish, before DDR-153: the whole build as base64 in one body. */
async function publishSingleBody(request: PublishRequest): Promise<PublishOutcome> {
  const { files, record: recordFiles } = request;
  const payload = JSON.stringify({
    projectId: request.projectId,
    repoName: request.repoName,
    // No `pin`: Cloud mints the review gate at publish and hands it back
    // (DDR-115). Sending one from here is what put every PIN a creator ever cut
    // into `freezes.json`, and `freezes.json` is tracked in Git.
    tag: request.tag,
    force: request.force === true ? true : undefined,
    files,
    // Beside the build, never inside it: the service keeps the two apart so
    // nothing in the record is ever served as an artifact (DDR-129).
    record: recordFiles,
  });
  // The record is named as the creator knows it, so `decisions/…` is not read
  // as part of the build.
  const sent = [
    ...files,
    ...(recordFiles ?? []).map((file) => ({ ...file, path: `design/${file.path}` })),
  ];
  const payloadBytes = Buffer.byteLength(payload);
  if (payloadBytes > PUBLISH_BODY_LIMIT) {
    return { ok: false, refusal: { error: oversizeRefusal(payloadBytes, sent) } };
  }

  const res = await fetch(`${request.base}/api/cli/publish`, {
    method: "POST",
    headers: request.headers,
    body: payload,
  });
  // The host's own 413, if its limit is ever lower than the one above.
  return readOutcome<PublishResult>(request.base, res, () => oversizeRefusal(payloadBytes, sent));
}

export interface WithdrawResult {
  tag: string;
  alreadyWithdrawn?: boolean;
}

/**
 * Stops Cloud serving a published freeze (DDR-086).
 *
 * The URL keeps resolving — a stakeholder mid-review gets a notice rather than a
 * dead link — and the freeze still counts against the plan, because DDR-077
 * counts freezes ever published.
 */
export async function withdrawPublished(input: {
  projectId: string;
  tag: string;
}): Promise<{ ok: true; result: WithdrawResult } | { ok: false; refusal: PublishRefusal }> {
  const config = await readUserConfig();
  if (!config.cloudToken) {
    return { ok: false, refusal: { error: NOT_SIGNED_IN } };
  }
  const base = await cloudApiUrl();

  const res = await fetch(`${base}/api/cli/withdraw`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.cloudToken}`,
    },
    body: JSON.stringify({ projectId: input.projectId, tag: input.tag }),
  });

  // The same reading publish gives its responses, which this was a copy of (TASK-542).
  return readOutcome<WithdrawResult>(base, res);
}
