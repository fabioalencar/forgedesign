// Filesystem scanner for a Design Record (spec/format.md §2, "the file set").
// Progressive scaffolding means most files are optional — a missing file is
// not an error, it's simply absent from the returned record.

import { promises as fs } from "node:fs";
import path from "node:path";

export const CORE_FILES = [
  "Brief.md",
  "Todos.md",
  "Glossary.md",
  "OpenQuestions.md",
  "forge.json",
] as const;

export const ON_DEMAND_FILES = [
  "Feedbacks.md",
  "Stakeholders.md",
  "UserStories.md",
  "UserRoles.md",
  "DataModel.md",
  "ProcessFlows.md",
  "Calendar.md",
  "Design.md",
  "Components.md",
  "FeatureLog.md",
] as const;

export const RECORD_FILES = [...CORE_FILES, ...ON_DEMAND_FILES] as const;
export type RecordFileName = (typeof RECORD_FILES)[number];

export interface ScannedFile {
  relPath: string;
  text: string;
}

export interface ScannedDecision {
  relPath: string;
  filename: string;
  text: string;
}

export interface ScannedRecord {
  root: string;
  files: Partial<Record<RecordFileName, ScannedFile>>;
  decisions: ScannedDecision[];
  /** Files whose name differs from a record file's only by case (see below). */
  caseCollisions: CaseCollision[];
}

/**
 * A file that is not a record file but that a case-insensitive filesystem
 * (APFS, NTFS) would resolve a record file's name to. `TODOS.md` next to a
 * record expecting `Todos.md` is the real case: opening "Todos.md" silently
 * returns the other file's bytes, so the record reads as valid and empty. The
 * scanner refuses to read these and reports them instead.
 */
export interface CaseCollision {
  /** The record file name that was being looked for, e.g. "Todos.md". */
  expected: RecordFileName;
  /** The differently-cased name actually on disk, e.g. "TODOS.md". */
  found: string;
}

/**
 * How a path relates to what is actually on disk, asked case-exactly.
 *
 * `fs.access("Todos.md")` answers yes on APFS/NTFS when the directory holds
 * `TODOS.md`, which is how a record ends up pointing at a file that isn't in
 * the format. Every writer that creates a record file must ask this instead —
 * `present` means the exact name is there, `collision` means a differently
 * cased file already owns that path and writing is impossible.
 */
export type PathState =
  | { kind: "absent" }
  | { kind: "present" }
  | { kind: "collision"; found: string };

export async function pathState(absPath: string): Promise<PathState> {
  const base = path.basename(absPath);
  let listing: string[];
  try {
    listing = await fs.readdir(path.dirname(absPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  if (listing.includes(base)) return { kind: "present" };
  const variant = listing.find((entry) => entry.toLowerCase() === base.toLowerCase());
  return variant ? { kind: "collision", found: variant } : { kind: "absent" };
}

/**
 * Reads every known record file that exists under `root`, plus decisions/*.md.
 *
 * File lookup goes through the directory listing rather than `fs.readFile`, so
 * a record file is only read when its name matches exactly — byte-for-byte, in
 * the case the spec defines. On a case-insensitive filesystem the two are not
 * the same question.
 */
export async function scanRecord(root: string): Promise<ScannedRecord> {
  let listing: string[];
  try {
    listing = await fs.readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    listing = [];
  }
  const present = new Set(listing);
  const byLowercase = new Map<string, string>();
  for (const name of listing) byLowercase.set(name.toLowerCase(), name);

  const files: Partial<Record<RecordFileName, ScannedFile>> = {};
  const caseCollisions: CaseCollision[] = [];
  for (const name of RECORD_FILES) {
    if (present.has(name)) {
      files[name] = { relPath: name, text: await fs.readFile(path.join(root, name), "utf8") };
      continue;
    }
    const variant = byLowercase.get(name.toLowerCase());
    if (variant) caseCollisions.push({ expected: name, found: variant });
  }

  const decisions: ScannedDecision[] = [];
  const decisionsDir = path.join(root, "decisions");
  try {
    const entries = await fs.readdir(decisionsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const text = await fs.readFile(path.join(decisionsDir, entry.name), "utf8");
      decisions.push({ relPath: path.join("decisions", entry.name), filename: entry.name, text });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  decisions.sort((a, b) => a.filename.localeCompare(b.filename));

  return { root, files, decisions, caseCollisions };
}
