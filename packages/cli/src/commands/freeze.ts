import { randomInt, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { buildPrototype, type PrototypeBuilds } from "../build.js";
import { bundleRootOf } from "../bundle-index.js";
import { registerSnapshot } from "../comments-client.js";
import { readUserConfig } from "../config.js";
import { generateFeatureLog } from "../feature-log.js";
import {
  appendFreeze,
  type FreezeRecord,
  findFreeze,
  readFreezes,
  todayIsoDate,
} from "../freezes.js";
import {
  commitPaths,
  createAnnotatedTag,
  currentBranch,
  deleteTag,
  headCommit,
  isWorkingTreeClean,
  requireRepoRoot,
  tagExists,
} from "../git.js";
import { generateHandoffPack } from "../handoff.js";
import { generateReleaseHub } from "../hub.js";
import { ensureProjectId, revertProjectId } from "../project.js";
import { readRecordVersion, versionRefusal } from "../record-version.js";
import { resolveTrail } from "../resolution-trail.js";
import { emitScenarioBundle } from "../scenario-emit.js";

export interface FreezeOptions {
  tag: string;
  message: string;
  cwd?: string;
  log?: (line: string) => void;
}

export interface FreezeResult {
  repoRoot: string;
  builds: PrototypeBuilds;
  record: FreezeRecord;
  warnings: string[];
}

export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Hard preconditions checked before the tag is created (spec §2). Throws. */
async function assertFreezable(root: string, options: FreezeOptions): Promise<void> {
  // DDR-095 applies here too, and this site was missed when it landed: a freeze
  // writes to the record — the feature log, the resolution trail's stamps — so
  // it is a writer, and a writer on a pre-0.2 record gets the one sentence that
  // names the way out. Before the tag, not after: `createAnnotatedTag` is the
  // first irreversible thing this command does, and a tag left behind by a
  // half-run freeze is what the immutability check above then refuses.
  //
  // Only a record that is *behind*. A repo with no `forge.json` at all is not a
  // stale record, it is one that has none — and freeze mints the manifest there
  // on purpose, to carry the projectId the comment API needs. Refusing that too
  // would have removed a working bootstrap as a side effect of a rule about old
  // formats, which is a different change than the one this decision asked for.
  const version = await readRecordVersion(root);
  if (version.kind === "migratable" || version.kind === "unknown") {
    throw new Error(versionRefusal(version));
  }

  if (!options.message?.trim()) {
    throw new Error("freeze requires --message (annotated tags carry the version story)");
  }
  if (!(await isWorkingTreeClean(root))) {
    throw new Error("working tree is not clean — commit or stash before freezing (spec §2)");
  }
  if (await tagExists(root, options.tag)) {
    throw new Error(`tag "${options.tag}" already exists — freezes are immutable, pick a new tag`);
  }
  if (findFreeze(await readFreezes(root), options.tag)) {
    throw new Error(`freezes.json already has an entry for "${options.tag}"`);
  }
}

/**
 * The freeze ceremony, in spec §2 order: clean-tree check → annotated tag →
 * builds → freezes.json → commit. Overlay injection + snapshot registration
 * (T-009) and the handoff pack (T-011) plug into the
 * marked slots. If anything fails after tagging, the tag created by this run
 * is removed so a failed freeze leaves no trace.
 */
export async function runFreeze(options: FreezeOptions): Promise<FreezeResult> {
  const log = options.log ?? (() => {});
  const warnings: string[] = [];

  const root = await requireRepoRoot(options.cwd);
  await assertFreezable(root, options);
  const branch = await currentBranch(root);
  if (branch !== "main" && branch !== "master") {
    warnings.push(`freezing from branch "${branch}" — freezes normally happen on main`);
  }

  log(`Tagging ${options.tag}…`);
  await createAnnotatedTag(root, options.tag, options.message);

  let cleanupProjectFile: (() => Promise<void>) | null = null;
  try {
    log("Building prototype and Storybook…");
    const builds = await buildPrototype(root);

    // The snapshot registers with the comment API so a stakeholder can comment
    // once the freeze is hosted by `forge publish` (DDR-073).
    const config = await readUserConfig();
    // Narrow once to a typed config (or null) instead of `!`-asserting later.
    const commentsConfig =
      config.commentsApiUrl && config.commentsApiKey
        ? { apiUrl: config.commentsApiUrl, apiKey: config.commentsApiKey }
        : null;
    const pin = generatePin();
    let snapshotId: string | null = null;
    let projectId: string | null = null;
    let projectFileCreated = false;
    if (commentsConfig) {
      // Read the manifest before ensureProjectId touches it, so a rollback can
      // put back exactly what was there rather than deleting a file the user
      // wrote (TASK-335).
      const before = await fs
        .readFile(path.join(root, "forge.json"), "utf8")
        .catch(() => null as string | null);
      const project = await ensureProjectId(root); // once — reused for registration
      projectId = project.projectId;
      projectFileCreated = project.created;
      if (project.created) {
        cleanupProjectFile = () => revertProjectId(root, before);
      }
      // The snapshot is still minted and registered here — the comment API has
      // to know a freeze exists before anyone can comment on it. What no longer
      // happens is injecting the toolbar into the build: freeze produces, Cloud
      // serves, and the toolbar is added per response at serve time (DDR-073).
      // Injecting here made a hosted freeze load it twice (TASK-357), and left
      // the artifact carrying a review layer it should not contain.
      snapshotId = randomUUID();
    } else {
      warnings.push(
        "comment overlay skipped — set commentsApiUrl and commentsApiKey in ~/.forge/config.json to enable stakeholder comments",
      );
    }

    // The scenario runtime bundle rides along with the overlay: both must be in
    // the build before it deploys, because a hosted freeze is exactly where the
    // Preview Bridge cannot reach (DDR-063).
    const emitted = await emitScenarioBundle(root, builds.prototypeDir);
    if (emitted.path !== null) {
      log(`Emitting ${emitted.count} scenario(s) for the runtime…`);
      for (const warning of emitted.warnings) warnings.push(warning);
    }

    // Freeze produces; Cloud serves (DDR-073). Deploying from here made a
    // frozen build exist at two URLs with two lifetimes, and the one freeze
    // controlled was the one nobody was reviewing. `forge publish` hosts it.
    // The fields stay null rather than disappearing: freezes recorded before
    // this carry real URLs, and rewriting history to tidy a schema would be
    // worse than a column that is empty from here on (TASK-334).
    const previewUrl = null;
    const storybookUrl = null;

    if (commentsConfig && snapshotId && projectId) {
      log("Registering snapshot with the comment API…");
      await registerSnapshot(commentsConfig, {
        id: snapshotId,
        projectId,
        tag: options.tag,
        pin,
        previewUrl,
      });
    }

    const date = todayIsoDate();

    // Handoff pack before appendFreeze, so "previous tag" = the last freeze.
    log("Generating handoff pack…");
    const handoff = await generateHandoffPack(root, {
      tag: options.tag,
      message: options.message,
      date,
      previewUrl,
      storybookUrl,
    });

    const record: FreezeRecord = {
      tag: options.tag,
      date,
      commit: await headCommit(root),
      previewUrl,
      storybookUrl,
      pin,
      snapshotId,
    };
    log("Writing freezes.json…");
    await appendFreeze(root, record);

    // Close the stakeholder's half of the loop (T-294): this release is where
    // accepted feedback ships, so it is the moment old share links can say so.
    // Best-effort — a comment API that is unreachable must not undo a freeze.
    // A record still on v0.1 has nowhere to read dispositions from, and saying
    // so on every freeze would be noise, so it is skipped without a word.
    let resolvedRecordRoot: string | null = null;
    if (commentsConfig && (await bundleRootOf(root)) !== null) {
      try {
        log("Resolving stakeholder comments addressed in this release…");
        const trail = await resolveTrail({
          tag: options.tag,
          cwd: root,
          previewUrl,
        });
        for (const warning of trail.warnings) warnings.push(warning);
        if (trail.stamped.length > 0) resolvedRecordRoot = trail.recordRoot;
        if (trail.addressed > 0) {
          log(
            `  ${trail.addressed} stakeholder comment(s) now read "addressed in ${options.tag}".`,
          );
        }
      } catch (error) {
        warnings.push(
          `resolution trail skipped — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // What this release actually closed (T-238). Derived from the tags, so it
    // is rewritten in full each freeze rather than appended to.
    try {
      const featureLog = await generateFeatureLog(root, await readFreezes(root));
      for (const warning of featureLog.warnings) warnings.push(warning);
      if (featureLog.path !== null) {
        // It writes the concept *and* regenerates the bundle index, so the
        // whole record root is what has to be committed — naming only the
        // feature log would leave the index modified and the tree dirty.
        resolvedRecordRoot ??= await bundleRootOf(root);
        const closed = featureLog.freezes[0]?.closed.length ?? 0;
        log(`Writing the feature log — ${closed} task(s) closed since the previous freeze.`);
      }
    } catch (error) {
      warnings.push(
        `feature log generation skipped — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let hubGenerated = false;
    try {
      log("Generating release hub…");
      hubGenerated = (await generateReleaseHub(root, await readFreezes(root))) !== null;
    } catch (error) {
      warnings.push(
        `release hub generation skipped — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    log("Committing freeze records…");
    const pathsToCommit = [
      "freezes.json",
      path.relative(root, handoff.dir),
      ...(hubGenerated ? ["hub"] : []),
      ...(projectFileCreated ? ["forge.json"] : []),
      // Everything the ceremony wrote inside the bundle — feedback stamped
      // `addressed_in` by the trail, the feature log, and the index both touch.
      // The tree was clean when the freeze started, so nothing else is pending.
      ...(resolvedRecordRoot ? [resolvedRecordRoot] : []),
    ];
    await commitPaths(root, pathsToCommit, `Freeze ${options.tag}: ${options.message}`);

    return { repoRoot: root, builds, record, warnings };
  } catch (error) {
    await deleteTag(root, options.tag).catch(() => {});
    await cleanupProjectFile?.().catch(() => {});
    throw error;
  }
}

export function registerFreezeCommand(program: Command): void {
  program
    .command("freeze")
    .argument("<tag>", "immutable version name (alpha, beta, mvp, …)")
    .requiredOption("-m, --message <message>", "annotated tag message")
    .description(
      "freeze the current version: annotated tag, prototype + Storybook builds, and a freezes.json entry committed on main; host it for review with `forge publish`",
    )
    .action(async (tag: string, opts: { message: string }) => {
      const result = await runFreeze({
        tag,
        message: opts.message,
        log: console.log,
      });
      for (const warning of result.warnings) console.warn(`warning: ${warning}`);
      console.log(`\nFroze ${result.record.tag} at ${result.record.commit.slice(0, 7)}`);
      console.log(
        `  preview:   ${result.record.previewUrl ?? `publish it with \`forge publish ${tag}\``}`,
      );
      console.log(`  storybook: ${result.record.storybookUrl ?? "not deployed"}`);
      console.log(`  stakeholder PIN: ${result.record.pin}`);
      console.log(`  handoff pack: handoff/${result.record.tag}/`);
      console.log("  release hub: hub/index.html (publish it with your preferred static host)");
      console.log(
        "\nThe tag and freeze commit are local — publish them with: git push --follow-tags",
      );
    });
}
