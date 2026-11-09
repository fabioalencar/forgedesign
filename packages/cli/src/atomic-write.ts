// Writing a state file so that nobody ever reads half of it (TASK-535).
//
// `fs.writeFile` truncates the file and then writes it, so for the length of
// the write the file on disk is empty or partial. Anything reading it then —
// the dashboard's background jobs, an agent's `forge status`, a second test
// worker — reads a JSON file that is not JSON, or a ledger missing its tail.
// `projects.json` was left invalid twice that way by two writers at once
// (vitest.config.ts has the history). Writing beside the file and renaming
// over it is atomic on one filesystem: a reader sees the old bytes or the new,
// never neither.
//
// It does not stop two writers from losing one another's update — the second
// rename wins whole. That needs the writer to re-read under a lock; this only
// guarantees that what wins is a whole file.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface AtomicWriteOptions {
  /**
   * The file's mode. Omitted, an existing file keeps the mode it had and a new
   * one gets the default — rename replaces the inode, so without this a mode
   * set by hand would quietly reset.
   */
  mode?: number;
}

/**
 * Creates a file that must not exist yet — a concept under an id this command
 * just allocated — and refuses if it does (TASK-537).
 *
 * Ids are allocated by scanning the record and taking the next number, so two
 * writers at once (the dashboard's triage job and an agent's `forge question`,
 * say) can pick the same one. Where the filename is the id — every Feedback,
 * Question, Scenario and `forge add` concept — the second plain write replaced
 * the first file, a stakeholder's comment included, and said nothing. `wx`
 * makes the filesystem the arbiter: one write wins, the other is told.
 */
export async function writeNewFile(file: string, data: string): Promise<void> {
  try {
    await fs.writeFile(file, data, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      `${file} already exists — something else wrote it while this ran, so nothing was written here; run it again`,
    );
  }
}

export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  // A symlinked file (a dotfiles repo's config, say) is written where it
  // points, so the link survives instead of being replaced by a plain file.
  const target = await fs.realpath(file).catch(() => file);
  const existingMode = await fs
    .stat(target)
    .then((stat) => stat.mode & 0o7777)
    .catch(() => undefined);
  const mode = options.mode ?? existingMode;
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID().slice(0, 8)}.tmp`,
  );
  try {
    // `wx`: the temp name is fresh, and this never writes through someone
    // else's file or link that happens to sit at it.
    await fs.writeFile(temp, data, { flag: "wx", mode: mode ?? 0o666 });
    // The mode given at creation is masked by the umask; an explicit one is
    // what the caller asked for, so it is set exactly.
    if (mode !== undefined) await fs.chmod(temp, mode);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}
