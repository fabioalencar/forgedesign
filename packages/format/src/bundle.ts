// The v0.2 bundle scanner (spec/format.md §2). The record is an OKF bundle
// rooted at `design/` — a subdirectory, never the repo root, because OKF
// conformance requires every non-reserved `.md` in the tree to carry
// frontmatter and a real project repo always has a README that will not
// (DDR-060).
//
// Progressive scaffolding still holds: a missing directory is not an error, it
// is simply a bundle without that kind of concept yet.

import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { type ParsedConcept, parseConcept } from "./concepts.js";

export const BUNDLE_DIR = "design";

/** OKF §3.1 reserves these at every level; they are never concept documents. */
export const RESERVED_FILENAMES = ["index.md", "log.md"] as const;
export type ReservedFilename = (typeof RESERVED_FILENAMES)[number];

export function isReservedFilename(name: string): name is ReservedFilename {
  return (RESERVED_FILENAMES as readonly string[]).includes(name);
}

export interface ScannedReservedFile {
  /** path relative to the bundle root, e.g. "decisions/index.md" */
  relPath: string;
  name: ReservedFilename;
  text: string;
}

export interface ScannedBundle {
  /** absolute path to the bundle root */
  root: string;
  /** false when the bundle directory does not exist — a v0.1 or pre-record repo */
  present: boolean;
  concepts: ParsedConcept[];
  reserved: ScannedReservedFile[];
}

export interface ScanBundleOptions {
  /** bundle directory relative to the repo root; defaults to `design` */
  recordRoot?: string;
}

/**
 * Reads every markdown file under the bundle root, parsing concepts and
 * collecting OKF's reserved files separately.
 *
 * Directory entries are taken from a listing rather than probed by path, so a
 * name is only ever matched byte-for-byte — on a case-insensitive filesystem
 * `fs.readFile("Todos.md")` happily returns `TODOS.md`, which is how a record
 * ends up reading a file that isn't in the format (T-255).
 */
export async function scanBundle(
  repoRoot: string,
  options: ScanBundleOptions = {},
): Promise<ScannedBundle> {
  const root = path.join(repoRoot, options.recordRoot ?? BUNDLE_DIR);
  const concepts: ParsedConcept[] = [];
  const reserved: ScannedReservedFile[] = [];

  const present = await walk(root, "", concepts, reserved);

  concepts.sort((a, b) => a.relPath.localeCompare(b.relPath));
  reserved.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { root, present, concepts, reserved };
}

/** Every concept of a given type, in path order. */
export function conceptsOfType(bundle: ScannedBundle, type: string): ParsedConcept[] {
  return bundle.concepts.filter((concept) => concept.type === type);
}

/** Index of concepts by their Forge `id`, skipping concepts that declare none. */
export function conceptsById(bundle: ScannedBundle): Map<string, ParsedConcept> {
  const index = new Map<string, ParsedConcept>();
  for (const concept of bundle.concepts) {
    if (concept.id !== null && !index.has(concept.id)) index.set(concept.id, concept);
  }
  return index;
}

async function walk(
  absDir: string,
  relDir: string,
  concepts: ParsedConcept[],
  reserved: ScannedReservedFile[],
): Promise<boolean> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }

  for (const entry of entries) {
    const relPath = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await walk(path.join(absDir, entry.name), relPath, concepts, reserved);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;

    const text = await fs.readFile(path.join(absDir, entry.name), "utf8");
    if (isReservedFilename(entry.name)) {
      reserved.push({ relPath, name: entry.name, text });
      continue;
    }
    concepts.push(parseConcept(relPath, text));
  }
  return true;
}
