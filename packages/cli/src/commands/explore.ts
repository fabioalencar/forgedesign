// forge explore (spec §2): speculative work happens on explore/<name>
// branches, optionally in sketch mode. Promotion is a normal merge; when a
// SKETCH.md rode along, it becomes a draft DDR for the designer to finish.
//
// The promotion DDR is written the same way `forge ddr apply` writes one, and
// that is the whole of TASK-418: this command used to write `decisions/` at the
// repo root and number the file by parsing filenames out of that directory. On
// a v0.2 record the bundle roots at `design/`, so the decision landed *outside*
// the record — invisible to `forge doctor` and `forge index` — and its id was
// allocated from a directory the record does not use, so it restarted at 001
// beside whatever DDR-001 the record already had. It also wrote a pre-v0.2
// body, with `- **Status**:` bullets and no frontmatter, which the format no
// longer accepts as a concept at all.

import { promises as fs } from "node:fs";
import path from "node:path";
import { nextId, scanBundle, withFrontmatter } from "@forgedesign/format";
import type { Command } from "commander";
import { writeBundleIndex } from "../bundle-index.js";
import { todayIsoDate } from "../freezes.js";
import {
  assertExploreName,
  branchExists,
  currentBranch,
  git,
  isWorkingTreeClean,
  requireRepoRoot,
} from "../git.js";
import { requireCurrentRecord } from "../record-version.js";

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

/**
 * A promotion DDR as a v0.2 concept: frontmatter first, `draft` rather than the
 * old `proposed` (which is not one of the format's decision statuses), and the
 * body the designer finishes before accepting it.
 */
function ddrFromPromotion(
  id: string,
  name: string,
  date: string,
  sketch: string | null,
  synthesis: PromotionSynthesis | undefined,
): string {
  const body = `## Decision

(distill the promotion rationale and source material below into one paragraph, then set decision_status to accepted)

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
  return withFrontmatter(
    {
      type: "Decision",
      id,
      title: name.replace(/-/g, " "),
      date,
      decision_status: "draft",
      context_source: `exploration branch explore/${name} (merged)`,
    },
    body,
  );
}

export interface MergeResult {
  branch: string;
  ddrPath: string | null;
}

/**
 * Promotion: merge explore/<name> into the current main/master branch and
 * write a draft DDR into the record (left uncommitted, on purpose — the
 * designer finishes and accepts it). A sketch and comparison synthesis become
 * source material.
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

  // Before the merge, not after: writing a DDR makes this a record writer, and
  // DDR-095 gives a writer on a pre-0.2 record one sentence naming its way out
  // rather than a second layout. Refusing *after* merging would leave the user
  // holding a completed merge and an error, so the check happens while there is
  // still nothing to undo. `--no-ddr` writes nothing, so it is exempt.
  const recordRoot = options.ddr === false ? null : (await requireCurrentRecord(root)).recordRoot;

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
  if (recordRoot !== null) {
    // The id comes from the ids the record's own concepts declare, exactly as
    // `forge ddr apply` allocates it — not from filenames in a directory, which
    // is how this ended up numbering from a tree the record does not read.
    const bundle = await scanBundle(root, { recordRoot });
    const id = nextId(
      bundle.concepts.flatMap((concept) =>
        concept.type === "Decision" && concept.id ? [concept.id] : [],
      ),
      "DDR",
    );
    const relPath = path.join(recordRoot, "decisions", `${id}-${options.name}.md`);
    ddrPath = path.join(root, relPath);
    await fs.mkdir(path.dirname(ddrPath), { recursive: true });
    await fs.writeFile(
      ddrPath,
      ddrFromPromotion(id, options.name, todayIsoDate(), sketch, options.synthesis),
      "utf8",
    );
    // The writer that adds a concept keeps the index true (T-300) — otherwise
    // the promotion leaves the record failing its own stale-index check.
    await writeBundleIndex(root);
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
    .option("--no-ddr", "skip writing the draft DDR")
    .description("promote an exploration: merge explore/<name> into main")
    .action(async (name: string, opts: { ddr: boolean }) => {
      const result = await mergeExplore({ name, ddr: opts.ddr });
      console.log(`Merged ${result.branch}.`);
      if (result.ddrPath) {
        console.log(
          `Created ${path.relative(process.cwd(), result.ddrPath)} (draft) — finish it, set decision_status to accepted, and commit.`,
        );
      }
    });
}
