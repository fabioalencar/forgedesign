// forge.json (spec/format.md §2, §7) — project manifest, carries formatVersion.

import path from "node:path";
import { BUNDLE_DIR } from "./bundle.js";

/** The root-file layout that predates the OKF bundle. Still read, no longer written. */
export const V01_FORMAT_VERSION = "0.1";
/** The OKF-conformant bundle format (spec/format.md v0.2). */
export const V02_FORMAT_VERSION = "0.2";
// What a new record gets is `V02_FORMAT_VERSION`; writers name it directly
// rather than through an alias, so there is exactly one spelling per version.
// Both are understood: v0.1 stays readable so a repo that has not migrated is
// not suddenly invalid, and `forge upgrade --to 0.2` is what moves it forward.
export const SUPPORTED_FORMAT_VERSIONS = [V01_FORMAT_VERSION, V02_FORMAT_VERSION] as const;

export interface ForgeManifest {
  formatVersion: string;
  [key: string]: unknown;
}

export function isSupportedFormatVersion(version: string | undefined): boolean {
  return (
    typeof version === "string" &&
    (SUPPORTED_FORMAT_VERSIONS as readonly string[]).includes(version)
  );
}

export function parseForgeJson(text: string): ForgeManifest {
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("forge.json must be a JSON object");
  }
  return parsed as ForgeManifest;
}

/**
 * The bundle directory a manifest names, relative to the repo root — `design`
 * when it names none — or null when `recordRoot` would put the record outside
 * the repository (TASK-528).
 *
 * The record is the repo (spec §1 principle 1), and every reader joins this
 * value to the repo root and then writes beneath it: the index, the ledger,
 * concepts from `forge add` and triage. So `"recordRoot": ".."` in a committed
 * forge.json pointed all of those writes at the directory above the repo. One
 * reader, so the CLI and the dashboard cannot disagree about where the record
 * is.
 */
export function recordRootOf(manifest: { readonly [key: string]: unknown }): string | null {
  const value = manifest.recordRoot;
  if (typeof value !== "string") return BUNDLE_DIR;
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  const outside =
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    normalized === ".." ||
    normalized.startsWith("../");
  return outside ? null : value;
}

export function buildForgeManifest(overrides: Partial<ForgeManifest> = {}): ForgeManifest {
  return { formatVersion: V02_FORMAT_VERSION, ...overrides };
}

export function serializeForgeJson(manifest: ForgeManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
