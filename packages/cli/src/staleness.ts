// Refusing to run a binary that does not match its source (TASK-381).
//
// `~/.local/bin/forge` symlinks to `dist/index.js`, and `dist/` is gitignored
// and written only by `pnpm build`. So a session can edit `src/`, watch
// typecheck, lint, 277 tests and knip all pass, and the `forge` the creator
// actually runs is still the previous build. That happened on 2026-08-03: a
// freeze was published without the feature that had just been written, and
// nothing anywhere reported a problem, because nothing anywhere looks at
// `dist/`.
//
// It is silent in the other direction too, which is the nastier half: a stale
// `dist` means `forge doctor` is executing old rules, so a session can add a
// rule, watch it pass, and never once have run it.
//
// This makes that state loud. It is not a build system and does not try to be —
// it answers one question, "is the thing I am about to run older than the source
// beside it", and only when there is source beside it at all.

import type { Dirent } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Set to anything to run anyway. An escape hatch, so this can never hard-block. */
export const OVERRIDE_ENV = "FORGE_ALLOW_STALE";

export interface StalenessReport {
  /** repo-relative-ish path of the first source file found newer than the build */
  newer: string;
  binary: string;
}

/**
 * The newest mtime under `dir`, or the first path already newer than `limit`.
 *
 * Short-circuits: the common stale case is found in the first few files, and the
 * common fresh case walks a few dozen `stat` calls, which is well under a
 * millisecond. A build system would cache this; a guard should not need to.
 */
async function findNewerThan(dir: string, limit: number): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findNewerThan(abs, limit);
      if (found) return found;
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fs.stat(abs);
      if (stat.mtimeMs > limit) return abs;
    } catch {
      // A file that vanished between readdir and stat is not evidence of
      // anything — a build writing into this tree is the likeliest cause.
    }
  }
  return null;
}

/**
 * Whether the running build is older than the source next to it.
 *
 * Returns null — meaning "no opinion" — whenever the question does not apply:
 * an installed package has no `src/` to compare against, which is the case for
 * every user who did not clone the repo, and they must never see this.
 */
export async function checkStaleBuild(binaryPath: string): Promise<StalenessReport | null> {
  if (process.env[OVERRIDE_ENV]) return null;

  const distDir = path.dirname(binaryPath);
  const packageRoot = path.dirname(distDir);
  const srcDir = path.join(packageRoot, "src");

  let built: number;
  try {
    // Both must exist for the comparison to mean anything. `src/` missing is the
    // published-package case and is not a problem to report.
    const [binaryStat, srcStat] = await Promise.all([fs.stat(binaryPath), fs.stat(srcDir)]);
    if (!srcStat.isDirectory()) return null;
    built = binaryStat.mtimeMs;
  } catch {
    return null;
  }

  const newer = await findNewerThan(srcDir, built);
  return newer ? { newer: path.relative(packageRoot, newer), binary: binaryPath } : null;
}

/** What the creator reads. Names the fix, and the way out of the check. */
export function staleMessage(report: StalenessReport): string {
  return [
    `forge: this binary is older than the source it was built from.`,
    ``,
    `  ${report.newer} changed after ${path.basename(report.binary)} was built.`,
    ``,
    `Everything you run until you rebuild — including \`forge doctor\` — is the`,
    `previous version, and nothing else will tell you so. Rebuild with:`,
    ``,
    `  pnpm --filter @forgedesign/cli build`,
    ``,
    `Set ${OVERRIDE_ENV}=1 to run anyway.`,
  ].join("\n");
}
