import { promises as fs } from "node:fs";
import path from "node:path";

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
}

export function freezesPath(repoRoot: string): string {
  return path.join(repoRoot, "freezes.json");
}

/** Today as an ISO calendar day (YYYY-MM-DD) — freeze/sketch date stamps. */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function readFreezes(repoRoot: string): Promise<FreezeRecord[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(freezesPath(repoRoot), "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as FreezeRecord[]) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    // A freezes.json mangled by a bad merge should name itself, not crash with a
    // bare parser message.
    if (error instanceof SyntaxError) {
      throw new Error(
        `${freezesPath(repoRoot)} is not valid JSON — fix or delete it (${error.message})`,
      );
    }
    throw error;
  }
}

export async function appendFreeze(repoRoot: string, record: FreezeRecord): Promise<void> {
  const freezes = await readFreezes(repoRoot);
  freezes.push(record);
  await fs.writeFile(freezesPath(repoRoot), `${JSON.stringify(freezes, null, 2)}\n`, "utf8");
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
  const freezes = await readFreezes(repoRoot);
  const entry = findFreeze(freezes, tag);
  if (!entry) return false;
  entry.snapshotId = snapshotId;
  await fs.writeFile(freezesPath(repoRoot), `${JSON.stringify(freezes, null, 2)}\n`, "utf8");
  return true;
}

export function findFreeze(freezes: FreezeRecord[], tag: string): FreezeRecord | undefined {
  return freezes.find((f) => f.tag === tag);
}
