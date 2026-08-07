// `forge publish` — send a frozen build to Cloud (DDR-073, DDR-076).
//
// Only the artifact travels: Cloud hosts what freeze produced and adds the
// review toolbar at serve time, so nothing here injects anything.

import { promises as fs } from "node:fs";
import path from "node:path";
import { cloudApiUrl } from "./cloud-auth.js";
import { readUserConfig } from "./config.js";

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
  freezesUsed: number;
}

export interface PublishRefusal {
  error: string;
  refusal?: { limit: string; used: number; allowed: number };
  /** files the service thinks carry a secret (TASK-366); present only on that refusal */
  secrets?: Array<{ path: string; what: string }>;
}

export async function publishBuild(input: {
  buildDir: string;
  projectId: string;
  repoName: string;
  tag: string;
  snapshotId?: string | null;
  /** publish even when the service thinks the build carries a secret (TASK-366) */
  force?: boolean;
}): Promise<{ ok: true; result: PublishResult } | { ok: false; refusal: PublishRefusal }> {
  const config = await readUserConfig();
  if (!config.cloudToken) {
    return { ok: false, refusal: { error: "not signed in — run `forge login`" } };
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

  const res = await fetch(`${base}/api/cli/publish`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.cloudToken}`,
    },
    body: JSON.stringify({
      projectId: input.projectId,
      repoName: input.repoName,
      tag: input.tag,
      snapshotId: input.snapshotId ?? undefined,
      force: input.force === true ? true : undefined,
      files,
    }),
  });

  // Read as text first. Every refusal this service *intends* is JSON with an
  // `error`, but an unhandled exception in the route comes back as an HTML error
  // page — and parsing that into `{}` produced the single least useful message
  // this CLI has ever printed: "forge publish: undefined" (TASK-355).
  const raw = await res.text();
  let body: (PublishResult & PublishRefusal) | undefined;
  try {
    body = JSON.parse(raw) as PublishResult & PublishRefusal;
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    if (body && typeof body.error === "string") return { ok: false, refusal: body };
    // Not a refusal we know how to describe — say what the server actually did,
    // because a status code and a snippet are what make this reportable.
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
    return { ok: false, refusal: { error: "not signed in — run `forge login`" } };
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

  const raw = await res.text();
  let body: (WithdrawResult & PublishRefusal) | undefined;
  try {
    body = JSON.parse(raw) as WithdrawResult & PublishRefusal;
  } catch {
    body = undefined;
  }

  if (!res.ok) {
    if (body && typeof body.error === "string") return { ok: false, refusal: body };
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
