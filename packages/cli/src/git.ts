import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(repoRoot: string, args: string[]): Promise<string> {
  // 16 MB: `git log`/diff output on a large history can exceed the 1 MB default.
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * Goes before any revision that came out of a file rather than out of this
 * code (TASK-524).
 *
 * Git reads an argument that starts with `-` as an option wherever it sits
 * before `--`, so a tag is an option the moment it begins with one. Tags reach
 * these calls from `freezes.json` and commits from a Check report's `commit:`,
 * both tracked, both anyone with push access can write — and a "tag" of
 * `--output=<path>` turned `git diff` into a write to any path on the machine.
 * Validating each value would mean knowing every option git has; this tells
 * git where its options end, which it then enforces itself. Git 2.24 or later.
 */
export const END_OF_OPTIONS = "--end-of-options";

/**
 * A file exactly as it is at a ref — `git show <ref>:<path>`, bytes untouched.
 *
 * `git()` trims its output, which is right for a listing and wrong for a file
 * that is about to be copied somewhere: a published snapshot of the record
 * should be the bytes the tag holds, trailing newline included.
 */
export async function fileAtRef(repoRoot: string, ref: string, relPath: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["show", END_OF_OPTIONS, `${ref}:${relPath}`], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "buffer",
  });
  return stdout;
}

/**
 * Many files as they are at one ref, through a single `git cat-file --batch`
 * (TASK-533). A path git does not have at that ref is absent from the map.
 *
 * `fileAtRef` per file costs a process each, and doctor asks for every accepted
 * decision on every run: 124 processes and 1.1 s of a 1.37 s doctor on this
 * repo's own record, growing with each DDR. The batch protocol frames each
 * object by a header line naming its byte size, so names go one per line —
 * which a name containing a newline would break, so those few go through
 * `fileAtRef` instead.
 */
export async function filesAtRef(
  repoRoot: string,
  ref: string,
  relPaths: readonly string[],
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const framed: string[] = [];
  const unframed: string[] = [];
  for (const relPath of relPaths) {
    (/[\r\n]/.test(`${ref}${relPath}`) ? unframed : framed).push(relPath);
  }
  for (const relPath of unframed) {
    try {
      files.set(relPath, await fileAtRef(repoRoot, ref, relPath));
    } catch {
      // not at this ref
    }
  }
  if (framed.length === 0) return files;

  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["cat-file", "--batch"], { cwd: repoRoot });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`git cat-file failed: ${Buffer.concat(errors).toString().trim()}`)),
    );
    // Stdin, not argv: an object name here is never read as an option.
    child.stdin.end(framed.map((relPath) => `${ref}:${relPath}\n`).join(""));
  });

  // Each answer is `<oid> <type> <size>\n<content>\n`, or `<name> missing\n`
  // (also `ambiguous`), in the order asked.
  let offset = 0;
  for (const relPath of framed) {
    const lineEnd = output.indexOf(0x0a, offset);
    if (lineEnd === -1) break;
    const header = output.subarray(offset, lineEnd).toString("utf8").split(" ");
    offset = lineEnd + 1;
    const size = Number(header[2]);
    if (header.length !== 3 || !Number.isInteger(size)) continue;
    if (header[1] === "blob") files.set(relPath, output.subarray(offset, offset + size));
    offset += size + 1;
  }
  return files;
}

/** Root of the repo containing `dir`, or null when outside any Git repo. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    return await git(dir, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}

/** The repo root for `cwd` (default process.cwd()), or throw the canonical error. */
export async function requireRepoRoot(cwd?: string): Promise<string> {
  const root = await repoRoot(cwd ?? process.cwd());
  if (!root) throw new Error("not inside a Git repository");
  return root;
}

/** Whether a local branch exists (used by explore/preview). */
export async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Whether every commit on `branch` is already an ancestor of `into` — the
 * standard "fully merged, safe to delete" check (`git branch --merged` uses
 * the same primitive). */
export async function isBranchMerged(root: string, branch: string, into: string): Promise<boolean> {
  try {
    await git(root, ["merge-base", "--is-ancestor", END_OF_OPTIONS, branch, into]);
    return true;
  } catch {
    return false;
  }
}

/** Delete a local branch. Plain `-d` (never `-D`): git itself refuses if the
 * branch isn't fully merged, or is checked out in another worktree — the
 * safe default we want, not a check we need to duplicate. */
export async function deleteBranch(root: string, branch: string): Promise<void> {
  await git(root, ["branch", "-d", branch]);
}

/** Explore branch slugs: lowercase alphanumerics + hyphens. */
export const EXPLORE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Throw a single canonical error if `name` isn't a valid explore-branch slug. */
export function assertExploreName(name: string): void {
  if (!EXPLORE_NAME_RE.test(name)) {
    throw new Error(`"${name}" must be a lowercase slug (a-z, 0-9, hyphens)`);
  }
}

export async function isWorkingTreeClean(repoRoot: string): Promise<boolean> {
  return (await git(repoRoot, ["status", "--porcelain"])) === "";
}

export async function tagExists(repoRoot: string, tag: string): Promise<boolean> {
  try {
    await git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

export async function createAnnotatedTag(
  repoRoot: string,
  tag: string,
  message: string,
): Promise<void> {
  await git(repoRoot, ["tag", "-a", tag, "-m", message]);
}

export async function deleteTag(repoRoot: string, tag: string): Promise<void> {
  await git(repoRoot, ["tag", "-d", tag]);
}

export async function headCommit(repoRoot: string): Promise<string> {
  return git(repoRoot, ["rev-parse", "HEAD"]);
}

export async function commitPaths(
  repoRoot: string,
  paths: string[],
  message: string,
): Promise<void> {
  await git(repoRoot, ["add", "--", ...paths]);
  await git(repoRoot, ["commit", "-m", message, "--", ...paths]);
}

/**
 * The branch actually checked out, or null when HEAD is detached (or this is
 * not a repo). `currentBranch` formats a detached HEAD for display; this
 * answers the yes/no question callers branch on.
 */
export async function checkedOutBranch(repoRoot: string): Promise<string | null> {
  try {
    return await git(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    return null;
  }
}

/**
 * Current branch name; works on unborn branches (fresh `git init`).
 * Falls back to a short detached-HEAD marker, or null when not a Git repo.
 */
export async function currentBranch(repoRoot: string): Promise<string | null> {
  try {
    return await git(repoRoot, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    try {
      const sha = await git(repoRoot, ["rev-parse", "--short", "HEAD"]);
      return `detached @ ${sha}`;
    } catch {
      return null;
    }
  }
}
