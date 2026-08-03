// `forge index` — regenerates the bundle-root index.md from the concepts on
// disk (spec/format.md §2; T-300). Deterministic and idempotent: the index is
// wholly derived from the file listing, so regenerating a current one is a
// no-op and doctor's staleness check is just "rebuild and compare".

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BUNDLE_DIR,
  buildBundleIndex,
  INDEX_FILENAME,
  isGeneratedIndex,
  parseForgeJson,
  scanBundle,
  V02_FORMAT_VERSION,
} from "@forgedesign/format";

export interface IndexResult {
  /** repo-relative path written, or null when this record has no bundle */
  path: string | null;
  changed: boolean;
  conceptCount: number;
}

/** The bundle directory for a v0.2 record, or null when this isn't one. */
export async function bundleRootOf(root: string): Promise<string | null> {
  let manifest: { formatVersion?: unknown; recordRoot?: unknown };
  try {
    manifest = parseForgeJson(await fs.readFile(path.join(root, "forge.json"), "utf8"));
  } catch {
    return null;
  }
  if (manifest.formatVersion !== V02_FORMAT_VERSION) return null;
  return typeof manifest.recordRoot === "string" ? manifest.recordRoot : BUNDLE_DIR;
}

/**
 * Rewrites `<bundle>/index.md`. Refuses to overwrite a hand-written index —
 * one without the generation marker is somebody's own writing, and clobbering
 * it would be the "derived files are never hand-edited" rule pointed backwards.
 */
export async function writeBundleIndex(root: string): Promise<IndexResult> {
  const recordRoot = await bundleRootOf(root);
  if (recordRoot === null) return { path: null, changed: false, conceptCount: 0 };

  const bundle = await scanBundle(root, { recordRoot });
  if (!bundle.present) return { path: null, changed: false, conceptCount: 0 };

  const relPath = path.join(recordRoot, INDEX_FILENAME);
  const absPath = path.join(root, relPath);
  const existing = await fs.readFile(absPath, "utf8").catch(() => null);
  if (existing !== null && !isGeneratedIndex(existing)) {
    return { path: relPath, changed: false, conceptCount: bundle.concepts.length };
  }

  const next = buildBundleIndex(bundle.concepts);
  if (existing === next)
    return { path: relPath, changed: false, conceptCount: bundle.concepts.length };

  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, next, "utf8");
  return { path: relPath, changed: true, conceptCount: bundle.concepts.length };
}
