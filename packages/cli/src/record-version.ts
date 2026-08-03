// What format a record is in, and what to say when it is not the current one
// (DDR-095).
//
// v0.1 is a migration source, not a supported format: every command that reads
// or writes a record answers an old one with the same sentence and stops. This
// module exists so that sentence is written once — six sites used to fork into
// a second implementation here, and the duplication is what TASK-328 got caught
// by.
//
// The distinction the callers kept getting wrong: **a missing forge.json is not
// a v0.1 record.** The old `readLayout` helpers returned "v0.1" whenever the
// manifest failed to parse *or* was absent, which would now send someone
// standing in an unrelated directory off to run `forge upgrade` — a command
// that would fabricate a record where there was none. An absent manifest with
// no old record beside it is `forge init`'s business, and only the presence of
// an actual pre-0.2 ledger makes it a migration.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  BUNDLE_DIR,
  type ForgeManifest,
  isSupportedFormatVersion,
  parseForgeJson,
  V01_FORMAT_VERSION,
  V02_FORMAT_VERSION,
} from "@forgedesign/format";

/** Ledgers that only exist in a pre-0.2 record, used when forge.json is absent. */
const LEGACY_LEDGERS = ["Todos.md", path.join("todo", "todo.md")] as const;

export type RecordVersion =
  /** The format this tooling serves. */
  | { kind: "current"; recordRoot: string; manifest: ForgeManifest }
  /** A pre-0.2 record. `forge upgrade` is the whole of what it gets. */
  | { kind: "migratable"; version: string | null }
  /** No forge.json and no old ledger — not a record at all. */
  | { kind: "absent" }
  /** forge.json is there and is not JSON. */
  | { kind: "unparseable" }
  /** A formatVersion this build has never heard of, which upgrade cannot help with. */
  | { kind: "unknown"; version: string };

async function exists(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return true;
  } catch {
    return false;
  }
}

export async function readRecordVersion(root: string): Promise<RecordVersion> {
  let text: string;
  try {
    text = await fs.readFile(path.join(root, "forge.json"), "utf8");
  } catch {
    // No manifest. A pre-0.1 record never had one — upgrade writes it — so the
    // ledger on disk is the only thing that can tell "old record" from "not a
    // record", and getting that backwards is the failure DDR-095 names.
    for (const ledger of LEGACY_LEDGERS) {
      if (await exists(path.join(root, ledger))) return { kind: "migratable", version: null };
    }
    return { kind: "absent" };
  }

  let manifest: ForgeManifest;
  try {
    manifest = parseForgeJson(text);
  } catch {
    return { kind: "unparseable" };
  }

  const version = typeof manifest.formatVersion === "string" ? manifest.formatVersion : undefined;
  if (version === V02_FORMAT_VERSION) {
    return {
      kind: "current",
      recordRoot: typeof manifest.recordRoot === "string" ? manifest.recordRoot : BUNDLE_DIR,
      manifest,
    };
  }
  if (isSupportedFormatVersion(version)) return { kind: "migratable", version: version ?? null };
  return { kind: "unknown", version: version ?? "(missing)" };
}

/**
 * The one sentence an old record gets.
 *
 * `unknown` deliberately does not say "run `forge upgrade`", which is what the
 * v0.1 rule used to say for every version it did not recognise. A record
 * written by a *newer* Forge is not behind us, and telling its owner to migrate
 * backwards is advice that cannot work.
 */
export function versionRefusal(version: Exclude<RecordVersion, { kind: "current" }>): string {
  switch (version.kind) {
    case "migratable":
      return version.version === null
        ? "this record predates format 0.2 — run `forge upgrade --to 0.2`"
        : `this record is format ${version.version} — run \`forge upgrade --to 0.2\``;
    case "absent":
      return "forge.json not found — not a Forge record (run `forge init`)";
    case "unparseable":
      return "forge.json is not valid JSON";
    case "unknown":
      return `forge.json#formatVersion "${version.version}" is not a format this build understands — it serves ${V02_FORMAT_VERSION} and migrates ${V01_FORMAT_VERSION}, so this record may need a newer Forge`;
  }
}

/** Thrown by the record-writing commands, which report rather than return findings. */
export class RecordVersionError extends Error {}

/**
 * The current record's bundle, or a thrown refusal. For the writers — `doctor`
 * turns the same states into findings instead, because reporting is its job.
 */
export async function requireCurrentRecord(
  root: string,
): Promise<{ recordRoot: string; manifest: ForgeManifest }> {
  const version = await readRecordVersion(root);
  if (version.kind === "current")
    return { recordRoot: version.recordRoot, manifest: version.manifest };
  throw new RecordVersionError(versionRefusal(version));
}
