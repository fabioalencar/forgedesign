import { promises as fs } from "node:fs";
import path from "node:path";

/** One entry per freeze, appended by `forge freeze` (spec §2 step 8). */
export interface FreezeRecord {
  tag: string;
  date: string;
  commit: string;
  previewUrl: string | null;
  storybookUrl: string | null;
  pin: string;
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
