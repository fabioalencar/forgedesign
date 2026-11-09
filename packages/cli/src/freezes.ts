import path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { withRepoLock } from "./file-lock.js";
import { readJsonFile } from "./json-file.js";

/** One entry per freeze, appended by `forge freeze` (spec §2 step 8). */
export interface FreezeRecord {
  tag: string;
  date: string;
  commit: string;
  previewUrl: string | null;
  storybookUrl: string | null;
  /**
   * The stakeholder PIN — **legacy, and never written any more** (TASK-447,
   * DDR-115).
   *
   * `forge freeze` used to mint six digits and record them here, which put every
   * review gate a creator ever cut into a file that is tracked in Git: present in
   * every clone, fork, contractor checkout and archive, and public the moment the
   * repository was. A PIN is a property of *hosting*, so Cloud mints it at
   * publish and shows it to the creator there.
   *
   * The field stays optional rather than disappearing because freezes cut before
   * the change carry a real value, and it is the only copy of a PIN registered
   * back then — deleting it from a record would lock its own creator out of a
   * review that is still being served. Nothing reads it to make a decision; it is
   * kept so a person can find it.
   */
  pin?: string;
  /** comment-API snapshot id; null until the snapshot is registered (T-009) */
  snapshotId: string | null;
  /**
   * `route → sha256:<hex>` of each built route's `index.html`, recorded at
   * freeze (TASK-461, DDR-121). What "which screens changed" is derived from:
   * a route whose hash differs from the previous freeze's changed. Optional
   * because freezes cut before this carry none, and the comparison says so
   * rather than guessing.
   */
  routes?: Record<string, string>;
}

export function freezesPath(repoRoot: string): string {
  return path.join(repoRoot, "freezes.json");
}

/**
 * The calendar day an instant falls on where the creator is, as YYYY-MM-DD
 * (TASK-534).
 *
 * `toISOString().slice(0, 10)` is the day in UTC, which is tomorrow for the
 * last hours of every evening west of Greenwich: a freeze cut at 21:30 in São
 * Paulo was dated the next day, and so was every decision, question and task
 * stamped then. A record's dates are the creator's calendar, not the server's.
 */
export function localIsoDate(instant: Date): string {
  const month = String(instant.getMonth() + 1).padStart(2, "0");
  const day = String(instant.getDate()).padStart(2, "0");
  return `${instant.getFullYear()}-${month}-${day}`;
}

/** Today as an ISO calendar day (YYYY-MM-DD) — freeze/sketch date stamps. */
export function todayIsoDate(): string {
  return localIsoDate(new Date());
}

export async function readFreezes(repoRoot: string): Promise<FreezeRecord[]> {
  const parsed = await readJsonFile(freezesPath(repoRoot));
  return Array.isArray(parsed) ? (parsed as FreezeRecord[]) : [];
}

/** The lock every writer of `freezes.json` takes (TASK-548). */
const FREEZES_LOCK = "freezes";

export async function appendFreeze(repoRoot: string, record: FreezeRecord): Promise<void> {
  // Under the lock the check is the one that counts: two freezes of the same
  // tag both passed it before either wrote.
  await withRepoLock(repoRoot, FREEZES_LOCK, async () => {
    const freezes = await readFreezes(repoRoot);
    if (findFreeze(freezes, record.tag)) {
      throw new Error(`freezes.json already has an entry for "${record.tag}"`);
    }
    freezes.push(record);
    await writeFileAtomic(freezesPath(repoRoot), `${JSON.stringify(freezes, null, 2)}\n`);
  });
}

/**
 * Records the snapshot the control plane minted for an already-published tag
 * (DDR-104).
 *
 * The only field a freeze entry gains after it is written. A freeze is immutable
 * and `freezes.json` is its record, so this is deliberately narrow: it updates
 * one key on one entry and refuses to invent an entry that is not there.
 */
export async function setFreezeSnapshotId(
  repoRoot: string,
  tag: string,
  snapshotId: string,
): Promise<boolean> {
  return withRepoLock(repoRoot, FREEZES_LOCK, async () => {
    const freezes = await readFreezes(repoRoot);
    const entry = findFreeze(freezes, tag);
    if (!entry) return false;
    entry.snapshotId = snapshotId;
    await writeFileAtomic(freezesPath(repoRoot), `${JSON.stringify(freezes, null, 2)}\n`);
    return true;
  });
}

export function findFreeze(freezes: FreezeRecord[], tag: string): FreezeRecord | undefined {
  return freezes.find((f) => f.tag === tag);
}
