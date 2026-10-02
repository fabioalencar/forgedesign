// The resolution trail (T-294): projecting the record's dispositions back onto
// the comments that caused them.
//
// A stakeholder who commented on a frozen preview currently gets silence. The
// forge-triage skill already closes the loop *inside* the record — a comment becomes
// a FEEDBACK, an accepted one becomes a TASK, the task gets done in some later
// release — and every fact needed to tell them so is already on disk. This
// reads those facts and tells the comment service, so an old share link can say
// "2 of your comments addressed in v3 →" instead of nothing.
//
// The direction is one-way on purpose (DDR-064): the record decides, the
// service displays. Nothing here reads a status back from the API.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  findTask,
  type ParsedConcept,
  parseTodos,
  scanBundle,
  setFrontmatterFields,
  taskView,
} from "@forgedesign/format";
import { bundleRootOf, writeBundleIndex } from "./bundle-index.js";
import { type CommentResolution, commentsApiFor, syncResolutions } from "./comments-client.js";
import { readUserConfig } from "./config.js";
import { type FreezeRecord, readFreezes } from "./freezes.js";
import { requireRepoRoot } from "./git.js";

export interface ResolveTrailOptions {
  /** the release that ships the addressed work */
  tag: string;
  cwd?: string;
  /**
   * Preview URL for `tag`. `forge freeze` knows it before the freeze is
   * appended to freezes.json; a standalone run looks it up there.
   */
  previewUrl?: string | null;
  log?: (line: string) => void;
}

export interface ResolveTrailResult {
  /** feedback items newly marked as shipped in this release */
  addressed: number;
  /** declined feedback pushed outward (first time or repaired) */
  declined: number;
  /** stakeholder questions told what answered them (TASK-462) */
  answered: number;
  /** comment rows the service reported updating */
  synced: number;
  /** FEEDBACK ids stamped `addressed_in` by this run */
  stamped: string[];
  /** repo-relative bundle root, so a caller can commit what was stamped */
  recordRoot: string | null;
  warnings: string[];
}

/** One feedback's outward projection, before it is grouped by snapshot. */
interface Projection {
  concept: ParsedConcept;
  snapshotId: string;
  resolution: CommentResolution;
  /** frontmatter to stamp on the concept once the service has accepted it */
  stamp: Record<string, unknown> | null;
}

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * `FREEZE-003` → the third entry in freezes.json, which is how triage assigned
 * the id in the first place. A record whose freezes.json was rewritten by hand
 * gets a warning rather than a comment pushed onto the wrong snapshot.
 */
function freezeFor(freezes: FreezeRecord[], freezeId: string): FreezeRecord | null {
  const number = Number.parseInt(freezeId.replace(/^FREEZE-/, ""), 10);
  if (!Number.isInteger(number) || number < 1) return null;
  return freezes[number - 1] ?? null;
}

/**
 * Reads the record and works out what to tell the service about each
 * review-sourced feedback item. Pure with respect to the network: every
 * decision is made from files, so the sync is a dumb write.
 */
function project(
  concepts: readonly ParsedConcept[],
  freezes: FreezeRecord[],
  ledger: ReturnType<typeof parseTodos>,
  tag: string,
  previewUrl: string | null,
  warnings: string[],
): Projection[] {
  const decisionTitles = new Map(
    concepts
      .filter((c) => c.type === "Decision" && c.id)
      .map((c) => [c.id as string, c.title ?? c.id] as const),
  );
  const titles = new Map(
    concepts.filter((c) => c.id).map((c) => [c.id as string, c.title ?? c.id] as const),
  );
  /** What an id names, for a note a stakeholder will read beside their question. */
  const titleOf = (id: string): string => {
    if (id.startsWith("TASK-")) {
      const entry = findTask(ledger, id);
      return entry ? taskView(entry).title : "see the record";
    }
    return titles.get(id) ?? "see the record";
  };
  const urlForTag = (wanted: string): string | null =>
    freezes.find((f) => f.tag === wanted)?.previewUrl ?? null;

  const projections: Projection[] = [];
  for (const concept of concepts) {
    if (concept.type !== "Feedback" && concept.type !== "Question") continue;
    const commentId = asString(concept.frontmatter.comment);
    const freezeId = asString(concept.frontmatter.freeze);
    if (commentId === null || freezeId === null) continue; // not a hosted-review comment

    const freeze = freezeFor(freezes, freezeId);
    if (!freeze?.snapshotId) {
      warnings.push(`${concept.id ?? concept.relPath}: ${freezeId} has no registered snapshot`);
      continue;
    }

    const status = concept.domainStatus?.value ?? null;
    const resolution = asString(concept.frontmatter.resolution);

    // A question is answered, never shipped (TASK-462): the note carries what
    // answered it, the way a declined comment's note carries its decision, and
    // the answer's own text stays in the record. Nothing to stamp — the
    // question's status is already the fact.
    if (concept.type === "Question") {
      const note = resolution === null ? null : `${resolution}: ${titleOf(resolution)}`;
      if (status === "resolved" || status === "dropped") {
        projections.push({
          concept,
          snapshotId: freeze.snapshotId,
          resolution: {
            commentId,
            status: status === "resolved" ? "addressed" : "declined",
            note,
          },
          stamp: null,
        });
      }
      continue;
    }

    const alreadyAddressedIn = asString(concept.frontmatter.addressed_in);

    // Re-push what is already settled: a sync that failed last time (or a
    // service restored from backup) repairs itself on the next release rather
    // than leaving one stakeholder permanently in the dark.
    if (alreadyAddressedIn !== null) {
      projections.push({
        concept,
        snapshotId: freeze.snapshotId,
        resolution: {
          commentId,
          status: "addressed",
          resolvedInTag: alreadyAddressedIn,
          resolvedInUrl: alreadyAddressedIn === tag ? previewUrl : urlForTag(alreadyAddressedIn),
        },
        stamp: null,
      });
      continue;
    }

    if (status === "declined") {
      const note =
        resolution === null
          ? null
          : `${resolution}: ${decisionTitles.get(resolution) ?? "see the decision record"}`;
      projections.push({
        concept,
        snapshotId: freeze.snapshotId,
        resolution: { commentId, status: "declined", note },
        stamp: null,
      });
      continue;
    }

    // Accepted feedback is addressed when the task it produced is done — the
    // task ledger is the only place that knows, and asking it here is what
    // keeps "addressed" honest instead of "we meant to".
    if (status === "accepted" && resolution?.startsWith("TASK-")) {
      const entry = findTask(ledger, resolution);
      if (!entry) {
        warnings.push(`${concept.id ?? concept.relPath}: ${resolution} is not in the task ledger`);
        continue;
      }
      const view = taskView(entry);
      if (view.status !== "done" && !view.checked) continue; // still open — nothing to say yet
      projections.push({
        concept,
        snapshotId: freeze.snapshotId,
        resolution: {
          commentId,
          status: "addressed",
          resolvedInTag: tag,
          resolvedInUrl: previewUrl,
        },
        stamp: { feedback_status: "done", addressed_in: tag },
      });
    }
  }
  return projections;
}

/**
 * Projects every settled review comment in the record onto its snapshot.
 * Idempotent: re-running after a partial failure repairs the trail, and a
 * feedback item whose task is still open is simply left alone.
 */
export async function resolveTrail(options: ResolveTrailOptions): Promise<ResolveTrailResult> {
  const log = options.log ?? (() => {});
  const root = await requireRepoRoot(options.cwd);

  // Cloud first, the direct config as the operator's escape hatch — the same
  // rule every other `forge comments` subcommand follows (DDR-104). Reading the
  // direct config alone left a Cloud creator unable to close the loop (TASK-477).
  const api = commentsApiFor(await readUserConfig());

  const recordRoot = await bundleRootOf(root);
  if (recordRoot === null) {
    throw new Error(
      "the resolution trail reads the v0.2 bundle — run `forge upgrade --to 0.2` first",
    );
  }

  const bundle = await scanBundle(root, { recordRoot });
  const ledgerConcept = bundle.concepts.find((c) => c.type === "Task Ledger");
  const ledger = parseTodos(ledgerConcept?.body ?? "");
  const freezes = await readFreezes(root);
  const previewUrl =
    options.previewUrl ?? freezes.find((f) => f.tag === options.tag)?.previewUrl ?? null;

  const warnings: string[] = [];
  const projections = project(bundle.concepts, freezes, ledger, options.tag, previewUrl, warnings);
  if (projections.length === 0) {
    return { addressed: 0, declined: 0, answered: 0, synced: 0, stamped: [], recordRoot, warnings };
  }

  const bySnapshot = new Map<string, Projection[]>();
  for (const projection of projections) {
    const list = bySnapshot.get(projection.snapshotId) ?? [];
    list.push(projection);
    bySnapshot.set(projection.snapshotId, list);
  }

  let synced = 0;
  const stamped: string[] = [];
  let addressed = 0;
  let declined = 0;
  let answered = 0;

  for (const [snapshotId, group] of bySnapshot) {
    try {
      synced += await syncResolutions(
        api,
        snapshotId,
        group.map((p) => p.resolution),
      );
    } catch (error) {
      // Stamping locally after a failed push would claim a trail the
      // stakeholder cannot see; leave the record alone and retry next release.
      warnings.push(
        `snapshot ${snapshotId}: resolution sync failed (${error instanceof Error ? error.message : String(error)}) — the record was not stamped, rerun to retry`,
      );
      continue;
    }
    for (const projection of group) {
      if (projection.concept.type === "Question") {
        if (projection.resolution.status === "addressed") answered += 1;
        else declined += 1;
        continue;
      }
      if (projection.resolution.status === "declined") declined += 1;
      if (projection.stamp === null) continue;
      const abs = path.join(root, recordRoot, projection.concept.relPath);
      await fs.writeFile(
        abs,
        setFrontmatterFields(projection.concept.raw, projection.stamp),
        "utf8",
      );
      stamped.push(projection.concept.id ?? projection.concept.relPath);
      addressed += 1;
    }
  }

  if (stamped.length > 0) {
    await writeBundleIndex(root);
    log(`Marked ${stamped.join(", ")} shipped in ${options.tag}.`);
  }
  return { addressed, declined, answered, synced, stamped, recordRoot, warnings };
}
