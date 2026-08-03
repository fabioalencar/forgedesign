import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** Repo-committed identity: forge.json at the repo root (DDR-011). */
export interface ProjectFile {
  projectId?: string;
  preview?: PreviewConfig;
  build?: BuildConfig;
  /** Curated starter selected at initialization (DDR-024). */
  starter?: string;
}

/**
 * What `forge freeze` builds (DDR-052). Absent falls back to the pre-pivot
 * scaffold convention (prototype/ with build + build-storybook scripts).
 * Commands are shell-like strings, split without invoking a shell.
 */
export interface BuildConfig {
  /** Where the commands run, relative to the repo root. Defaults to ".". */
  dir?: string;
  command?: string;
  /** Static output directory, relative to `dir`. */
  output?: string;
  /** Omitted means this project has no Storybook; freeze deploys the prototype only. */
  storybook?: { command?: string; output?: string };
}

/** Repo-local preview settings. Strings are shell-like commands and are split
 * by preview.ts without invoking a shell. */
export interface PreviewConfig {
  /** Explicit development-only bridge adapter; no source scanning or rewriting. */
  adapter?: "react-vite";
  command?: string;
  dir?: string;
  /** false skips install; otherwise the command runs when a worktree is new. */
  install?: string | false;
}

export function projectFilePath(repoRoot: string): string {
  return path.join(repoRoot, "forge.json");
}

export async function readProjectFile(repoRoot: string): Promise<ProjectFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(projectFilePath(repoRoot), "utf8")) as ProjectFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

/**
 * Reads forge.json, creating it with a fresh UUID on first use. Created
 * lazily at freeze time so pre-existing repos pick up an identity without a
 * migration; the freeze commit carries it.
 */
export async function ensureProjectId(
  repoRoot: string,
): Promise<{ projectId: string; created: boolean; fileCreated: boolean }> {
  const file = projectFilePath(repoRoot);
  const existing = await fs.readFile(file, "utf8").catch(() => null);
  const parsed = await readProjectFile(repoRoot);
  if (typeof parsed.projectId === "string" && parsed.projectId) {
    return { projectId: parsed.projectId, created: false, fileCreated: false };
  }
  const projectId = randomUUID();
  await fs.writeFile(file, `${JSON.stringify({ ...parsed, projectId }, null, 2)}\n`, "utf8");
  // `created` says an id was minted; `fileCreated` says forge.json did not
  // exist at all. Conflating them let a failed freeze delete a manifest the
  // user had written — build config and all — because it had only *added* a
  // key to it (TASK-335).
  return { projectId, created: true, fileCreated: existing === null };
}

/**
 * Undoes what `ensureProjectId` just wrote, for a freeze that failed after it.
 * Removes the file only when it created the file; otherwise it restores the
 * exact bytes that were there before.
 */
export async function revertProjectId(repoRoot: string, before: string | null): Promise<void> {
  const file = projectFilePath(repoRoot);
  if (before === null) {
    await fs.rm(file, { force: true });
    return;
  }
  await fs.writeFile(file, before, "utf8");
}
