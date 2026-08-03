// forge explore (spec §2): speculative work happens on explore/<name>
// branches, optionally in sketch mode. Promotion is a normal merge; when a
// SKETCH.md rode along, it becomes a proposed DDR for the designer to finish.

import { promises as fs } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { todayIsoDate } from "../freezes.js";
import {
  assertExploreName,
  branchExists,
  currentBranch,
  git,
  isWorkingTreeClean,
  requireRepoRoot,
} from "../git.js";

function sketchTemplate(name: string, date: string): string {
  return `# Sketch — ${name}

- **Branch**: explore/${name}
- **Started**: ${date}

## Hypothesis

What are we exploring, and what would make it a keeper?

## Concepts

Drop static HTML/images into sketches/ and list them here with notes.

## Verdict

(fill before promoting: what won, what lost, why)
`;
}

export interface ExploreResult {
  branch: string;
  sketchPath: string | null;
}

export interface EnsureExploreResult {
  branch: string;
  created: boolean;
}

/**
 * Create-or-reuse for session starts (DDR-048): unlike `startExplore`, this
 * never switches the caller's checkout — the branch is created at the current
 * HEAD with `git branch`, and the preview worktree (DDR-020) is the only
 * runtime that ever checks it out. Reusing an existing branch is a no-op.
 */
export async function ensureExplore(options: {
  name: string;
  cwd?: string;
}): Promise<EnsureExploreResult> {
  assertExploreName(options.name);
  const root = await requireRepoRoot(options.cwd);
  const branch = `explore/${options.name}`;
  if (await branchExists(root, branch)) return { branch, created: false };
  await git(root, ["branch", branch]);
  return { branch, created: true };
}

export async function startExplore(options: {
  name: string;
  sketch?: boolean;
  cwd?: string;
}): Promise<ExploreResult> {
  assertExploreName(options.name);
  const root = await requireRepoRoot(options.cwd);

  const branch = `explore/${options.name}`;
  if (await branchExists(root, branch)) {
    throw new Error(`branch ${branch} already exists — pick a new name or check it out directly`);
  }
  await git(root, ["checkout", "-b", branch]);

  let sketchPath: string | null = null;
  if (options.sketch) {
    const dir = path.join(root, "sketches");
    await fs.mkdir(dir, { recursive: true });
    sketchPath = path.join(dir, "SKETCH.md");
    try {
      await fs.access(sketchPath);
    } catch {
      await fs.writeFile(sketchPath, sketchTemplate(options.name, todayIsoDate()), "utf8");
    }
  }
  return { branch, sketchPath };
}

async function nextDdrNumber(root: string): Promise<string> {
  let max = 0;
  try {
    for (const file of await fs.readdir(path.join(root, "decisions"))) {
      const n = Number(file.match(/^DDR-(\d+)/)?.[1] ?? 0);
      if (n > max) max = n;
    }
  } catch {
    // no decisions/ yet
  }
  return String(max + 1).padStart(3, "0");
}

export interface PromotionSynthesis {
  rationale: string;
  observations: Array<{ branch: string; note: string }>;
}

function synthesisSection(synthesis: PromotionSynthesis | undefined): string {
  const rationale = synthesis?.rationale.trim();
  const observations =
    synthesis?.observations
      .map(({ branch, note }) => ({ branch: branch.trim(), note: note.trim() }))
      .filter(({ branch, note }) => branch.length > 0 && note.length > 0) ?? [];

  if (!rationale && observations.length === 0) return "";

  const observationSection =
    observations.length > 0
      ? `### Variant observations

${observations.map(({ branch, note }) => `#### ${branch}\n\n${note}`).join("\n\n")}
`
      : "";

  return `
## Comparison synthesis

### Why this one

${rationale || "(add the rationale before accepting this DDR)"}

${observationSection}`;
}

function ddrFromPromotion(
  number: string,
  name: string,
  date: string,
  sketch: string | null,
  synthesis: PromotionSynthesis | undefined,
): string {
  const title = name.replace(/-/g, " ");
  return `# DDR-${number} — ${title}

- **Status**: proposed
- **Date**: ${date}
- **Context source**: exploration branch explore/${name} (merged)

## Decision

(distill the promotion rationale and source material below into one paragraph, then set Status to accepted)

## Why

## Alternatives rejected

## Consequences

---

${synthesisSection(synthesis)}${
  sketch
    ? `
## Sketch brief (imported from sketches/SKETCH.md)

${sketch.trim()}
`
    : ""
}
`;
}

export interface MergeResult {
  branch: string;
  ddrPath: string | null;
}

/**
 * Promotion: merge explore/<name> into the current main/master branch and
 * create a proposed DDR (left uncommitted, on purpose — the designer finishes
 * and accepts it). A sketch and comparison synthesis become source material.
 */
export async function mergeExplore(options: {
  name: string;
  ddr?: boolean;
  synthesis?: PromotionSynthesis;
  cwd?: string;
}): Promise<MergeResult> {
  const root = await requireRepoRoot(options.cwd);

  const branch = `explore/${options.name}`;
  if (!(await branchExists(root, branch))) {
    throw new Error(`no branch ${branch} in this repo`);
  }
  const current = await currentBranch(root);
  if (current !== "main" && current !== "master") {
    throw new Error(`promotion merges into main — you are on "${current}" (checkout main first)`);
  }
  if (!(await isWorkingTreeClean(root))) {
    throw new Error("working tree is not clean — commit or stash before merging");
  }

  // Capture main's tip before merging so we can tell whether SKETCH.md was
  // actually introduced by this branch, versus already sitting on main from a
  // prior promotion (which must NOT be re-converted — the re-conversion bug).
  const beforeMerge = await git(root, ["rev-parse", "HEAD"]);
  await git(root, ["merge", "--no-ff", branch, "-m", `Promote ${branch}`]);

  let ddrPath: string | null = null;
  const sketchFile = path.join(root, "sketches", "SKETCH.md");
  const sketchChanged =
    (await git(root, ["diff", "--name-only", beforeMerge, "HEAD", "--", "sketches/SKETCH.md"])) !==
    "";
  let sketch: string | null = null;
  if (sketchChanged) {
    try {
      sketch = await fs.readFile(sketchFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (options.ddr !== false) {
    const number = await nextDdrNumber(root);
    const date = todayIsoDate();
    ddrPath = path.join(root, "decisions", `DDR-${number}-${options.name}.md`);
    await fs.mkdir(path.dirname(ddrPath), { recursive: true });
    await fs.writeFile(
      ddrPath,
      ddrFromPromotion(number, options.name, date, sketch, options.synthesis),
      "utf8",
    );
  }
  return { branch, ddrPath };
}

export function registerExploreCommand(program: Command): void {
  const explore = program
    .command("explore")
    .description("speculative work on explore/<name> branches");

  explore
    .command("start", { isDefault: true })
    .argument("<name>", "exploration name (lowercase slug)")
    .option("--sketch", "sketch mode: scaffold sketches/ with a SKETCH.md brief")
    .description("create and switch to explore/<name>")
    .action(async (name: string, opts: { sketch?: boolean }) => {
      const result = await startExplore({ name, sketch: opts.sketch });
      console.log(`On ${result.branch}. Iterate freely — main stays untouched.`);
      if (result.sketchPath) {
        console.log(`Sketch brief: ${path.relative(process.cwd(), result.sketchPath)}`);
      }
      console.log(`Promote later with: forge explore merge ${name}`);
    });

  explore
    .command("merge")
    .argument("<name>", "exploration to promote")
    .option("--no-ddr", "skip creating the proposed DDR")
    .description("promote an exploration: merge explore/<name> into main")
    .action(async (name: string, opts: { ddr: boolean }) => {
      const result = await mergeExplore({ name, ddr: opts.ddr });
      console.log(`Merged ${result.branch}.`);
      if (result.ddrPath) {
        console.log(
          `Created ${path.relative(process.cwd(), result.ddrPath)} (proposed) — finish it, set it to accepted, and commit.`,
        );
      }
    });
}
