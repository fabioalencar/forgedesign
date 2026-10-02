import { promises as fs } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { buildPrototype, type PrototypeBuilds } from "../build.js";
import { bundleRootOf } from "../bundle-index.js";
import { checksSatisfied } from "../check.js";
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
import { hashBuiltRoutes } from "../routes.js";
import { emitScenarioBundle } from "../scenario-emit.js";

export interface FreezeOptions {
  tag: string;
  message: string;
  cwd?: string;
  /** refuse to tag unless every checker has a report for this commit (TASK-456) */
  requireCheck?: boolean;
  log?: (line: string) => void;
}

export interface FreezeResult {
  repoRoot: string;
  builds: PrototypeBuilds;
  record: FreezeRecord;
  warnings: string[];
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

  // The check gate (TASK-456, DDR-127): a report per checker, describing this
  // commit, under checks/<tag>/. Checked before the tag, like everything else
  // here, so a refusal leaves no trace.
  if (options.requireCheck) {
    if (version.kind !== "current") {
      throw new Error(
        "--require-check needs a current record — there is no bundle to hold check reports",
      );
    }
    const gaps = await checksSatisfied(
      root,
      version.recordRoot,
      options.tag,
      await headCommit(root),
    );
    const problems = [
      ...gaps.missing.map((name) => `${name} has no report`),
      ...gaps.stale.map((name) => `${name}'s report is for an older commit`),
    ];
    if (problems.length > 0) {
      throw new Error(
        `--require-check: ${problems.join("; ")} — run \`forge check ${options.tag}\`, commit its reports, then freeze`,
      );
    }
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
    // Identity before the build, so the rollback covers a failed build too.
    // It used to sit after registration, which is where it happened to be when
    // registration was the only caller — and it left a window where a build
    // failure could not restore a manifest that had already been written
    // (TASK-335's lesson, now with a wider guard).
    //
    // Read the manifest before ensureProjectId touches it, so a rollback puts
    // back exactly what was there rather than deleting a file the user wrote.
    const beforeProjectFile = await fs
      .readFile(path.join(root, "forge.json"), "utf8")
      .catch(() => null as string | null);
    // The repo identity `forge publish` sends to Cloud (TASK-416). Minted on
    // every freeze, not only one with a comment API configured.
    const project = await ensureProjectId(root);
    const projectFileCreated = project.created;
    if (project.created) {
      cleanupProjectFile = () => revertProjectId(root, beforeProjectFile);
    }

    log("Building prototype and Storybook…");
    const builds = await buildPrototype(root);

    // Read once: the resolution trail below runs only when someone is signed in.
    const config = await readUserConfig();
    // Null until `forge publish` mints the gate and writes the id back
    // (DDR-104). Freezes cut before that change carry a real id here and the
    // comment commands still read it, which is why the field stays.
    const snapshotId: string | null = null;

    // Every freeze, not only one with a comment API configured (TASK-416).
    // `projectId` is the repo's identity — `forge publish` sends it to Cloud as
    // the thing a hosted prototype belongs to — and minting it here used to sit
    // inside an `if` on the comment API config, left over from when the comment
    // API was the only thing that wanted an id. The consequence was that a
    // Cloud customer who had only run `forge login` froze successfully, got no
    // id, and then met `forge publish: this repo has no projectId in forge.json
    // — freeze once first`, which no amount of freezing would fix.
    //

    // No snapshot is registered here any more (DDR-104). Freeze produces and
    // Cloud serves (DDR-073), and a PIN gate is a property of *serving* — so
    // `forge publish` mints the snapshot, using a credential that stays on the
    // control plane. Registering it here required the deployment-wide
    // `COMMENTS_API_KEY` in a creator's own config, which authorises every
    // tenant's comments and so could never be a customer credential; the
    // consequence was that a Cloud creator froze with no snapshot and published
    // with no gate (TASK-419, TASK-420).
    //
    // The PIN is not generated here either any more (TASK-447, DDR-115). It used
    // to be, and it was written into `freezes.json` — a file that is tracked in
    // Git, so every review gate a creator ever cut travelled with the repository
    // into every clone, fork and archive, and went public the moment the
    // repository did. Nothing could read it back out of the service either, so
    // that committed copy was also the *only* copy.
    //
    // A PIN gates *serving*, and serving is Cloud's job (DDR-073). So Cloud mints
    // it at publish, shows it to the creator once on the way back, and keeps it
    // on the hosted freeze where they can look it up and change it. A freeze is
    // the version; the gate belongs to the place that hosts it.

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

    // Which screens this version has, as content hashes (TASK-461). Read from
    // the build the scenario bundle has already been emitted into, since that
    // is the artifact a stakeholder will see; the comparison with the previous
    // freeze happens wherever the freeze is read, never here.
    const routes = await hashBuiltRoutes(builds.prototypeDir);

    const record: FreezeRecord = {
      tag: options.tag,
      date,
      commit: await headCommit(root),
      previewUrl,
      storybookUrl,
      snapshotId,
      routes,
    };
    log("Writing freezes.json…");
    await appendFreeze(root, record);

    // Close the stakeholder's half of the loop (T-294): this release is where
    // accepted feedback ships, so it is the moment old share links can say so.
    // Best-effort — a comment API that is unreachable must not undo a freeze.
    // A record still on v0.1 has nowhere to read dispositions from, and saying
    // so on every freeze would be noise, so it is skipped without a word.
    // Any credential the comment commands accept, Cloud first (TASK-477) — not
    // only the direct config the snapshot registration above still uses.
    const signedIn = Boolean(config.cloudToken || (config.commentsApiUrl && config.commentsApiKey));
    let resolvedRecordRoot: string | null = null;
    if (signedIn && (await bundleRootOf(root)) !== null) {
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
    .option(
      "--require-check",
      "refuse to tag unless every checker has a report for this commit under design/checks/<tag>/ (see `forge check`)",
    )
    .description(
      "freeze the current version: annotated tag, prototype + Storybook builds, and a freezes.json entry committed on main; the build is static, so any host can serve it",
    )
    .action(async (tag: string, opts: { message: string; requireCheck?: boolean }) => {
      const result = await runFreeze({
        tag,
        message: opts.message,
        requireCheck: opts.requireCheck,
        log: console.log,
      });
      for (const warning of result.warnings) console.warn(`warning: ${warning}`);
      console.log(`\nFroze ${result.record.tag} at ${result.record.commit.slice(0, 7)}`);
      console.log(
        `  preview:   ${result.record.previewUrl ?? "not hosted — the build is static, so any host can serve it"}`,
      );
      console.log(`  storybook: ${result.record.storybookUrl ?? "not deployed"}`);
      console.log(`  handoff pack: handoff/${result.record.tag}/`);
      console.log("  release hub: hub/index.html (publish it with your preferred static host)");
      console.log(
        "\nThe tag and freeze commit are local — publish them with: git push --follow-tags",
      );
    });
}
