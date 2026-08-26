import { promises as fs } from "node:fs";
import path from "node:path";
import {
  addTask as addTaskEntry,
  findTask,
  type LedgerDocument,
  nextId,
  nextTaskId as nextTaskEntryId,
  parseTodos,
  scanBundle,
  serializeTodos,
  setBody,
  TASK_SECTIONS,
  withFrontmatter,
} from "@forgedesign/format";
import type { Command } from "commander";
import { writeBundleIndex } from "../bundle-index.js";
import {
  type ApiComment,
  archiveSnapshot,
  type CommentsApiConfig,
  fetchUnfetchedComments,
  markCommentsFetched,
  setSnapshotWindow,
} from "../comments-client.js";
import { readUserConfig } from "../config.js";
import { findFreeze, readFreezes, todayIsoDate } from "../freezes.js";
import { requireRepoRoot } from "../git.js";
import { requireCurrentRecord } from "../record-version.js";
import { resolveTrail } from "../resolution-trail.js";

const oneLine = (text: string) => text.replace(/\s*\r?\n\s*/g, " / ").trim();

/**
 * The calendar day a comment was written, from the service's timestamp (T-258).
 * A record that back-dates nothing is a record that cannot say when a review
 * actually happened — and triage often runs days after the freeze it is reading.
 * An unparseable or missing timestamp falls back to today rather than writing a
 * date the format would reject.
 */
function arrivalDate(createdAt: string | undefined, fallback: string): string {
  if (!createdAt) return fallback;
  const parsed = new Date(createdAt);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString().slice(0, 10);
}

/**
 * Where `forge comments` talks, and which credential it uses (DDR-104, TASK-420).
 *
 * **Cloud first, because the direct path was never a customer path.**
 * `commentsApiKey` is one deployment-wide secret that authorises every tenant's
 * comments, so a customer could not be given one — which is why every
 * `forge comments` subcommand used to refuse with an instruction no Cloud creator
 * could follow. Going through the control plane uses the `cloudToken` they
 * already have from `forge login`, and the control plane decides ownership,
 * because it is the only plane that knows who owns what.
 *
 * The base URL is the review plane's own paths under `/api/cli`, so nothing in
 * `comments-client.ts` changes — only where it points and what it presents.
 *
 * **The direct config survives as an operator and self-host escape hatch**, which
 * is exactly what DDR-104 left it as. It is checked second so that a machine
 * holding both — an operator's, typically — takes the path a customer would,
 * and any breakage shows up on the path that matters rather than hiding behind
 * a credential nobody else has.
 */
export function commentsApiFor(userConfig: {
  cloudApiUrl?: string;
  cloudToken?: string;
  commentsApiUrl?: string;
  commentsApiKey?: string;
}): CommentsApiConfig {
  if (userConfig.cloudToken) {
    const origin = (userConfig.cloudApiUrl ?? "https://useforge.design").replace(/\/$/, "");
    return { apiUrl: `${origin}/api/cli`, apiKey: userConfig.cloudToken };
  }
  if (userConfig.commentsApiUrl && userConfig.commentsApiKey) {
    return { apiUrl: userConfig.commentsApiUrl, apiKey: userConfig.commentsApiKey };
  }
  throw new Error(
    "not signed in — run `forge login`. (Self-hosting? Set commentsApiUrl and commentsApiKey in ~/.forge/config.json.)",
  );
}

/** Shared plumbing: repo root, API config, and the tag's registered snapshot. */
async function resolveSnapshot(
  tag: string,
  cwd?: string,
): Promise<{ root: string; api: CommentsApiConfig; snapshotId: string }> {
  const root = await requireRepoRoot(cwd);

  const api = commentsApiFor(await readUserConfig());

  const freeze = findFreeze(await readFreezes(root), tag);
  if (!freeze) throw new Error(`no freeze named "${tag}" in freezes.json`);
  if (!freeze.snapshotId) {
    throw new Error(
      `freeze "${tag}" has no registered snapshot — it was made without the comment API configured`,
    );
  }
  return { root, api, snapshotId: freeze.snapshotId };
}

export async function archiveTag(options: {
  tag: string;
  cwd?: string;
}): Promise<{ alreadyArchived: boolean }> {
  const { api, snapshotId } = await resolveSnapshot(options.tag, options.cwd);
  return archiveSnapshot(api, snapshotId);
}

/**
 * A deadline the creator typed, as an instant (T-387).
 *
 * **A bare date means the end of that day where the creator is**, because
 * "closes 4 September" means the 4th is still a day you can comment on — and
 * because JavaScript reads a date-only string as UTC midnight, which would
 * close the round most of a day early for anyone west of Greenwich and is
 * exactly the silent timezone bug this feature exists to avoid. A date *with* a
 * time is left to the engine, which reads an unzoned one as local — the same
 * answer, arrived at the same way.
 *
 * A deadline in the past is refused rather than accepted as an immediate close:
 * it is almost always a typo, and `forge comments archive` is the deliberate way
 * to end a round now.
 */
export function parseWindowDeadline(input: string, now = new Date()): string {
  const trimmed = input.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const at = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 23, 59, 59, 999)
    : new Date(trimmed);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`"${input}" is not a date — use YYYY-MM-DD, or a full date and time`);
  }
  if (at.getTime() <= now.getTime()) {
    throw new Error(
      `${at.toISOString()} is in the past — to end the round now, run \`forge comments archive\``,
    );
  }
  return at.toISOString();
}

/** Sets, extends or clears the feedback window on a freeze (T-387). */
export async function setWindow(options: {
  tag: string;
  closes: string | null;
  cwd?: string;
  now?: Date;
}): Promise<{ closesAt: string | null }> {
  const { api, snapshotId } = await resolveSnapshot(options.tag, options.cwd);
  const closesAt =
    options.closes === null ? null : parseWindowDeadline(options.closes, options.now);
  return setSnapshotWindow(api, snapshotId, closesAt);
}

export interface TriageStageResult {
  /** repo-relative path to the staged comments, or null when nothing to triage */
  staged: string | null;
  count: number;
}

const triageCommentsPath = (root: string, tag: string) =>
  path.join(root, ".forge", "triage", tag, "comments.json");
const triageProposalJsonPath = (root: string, tag: string) =>
  path.join(root, ".forge", "triage", tag, "proposal.json");
const triageSummaryPath = (root: string, tag: string) =>
  path.join(root, ".forge", "triage", tag, "proposal.md");

/**
 * Fetches new comments for `tag` and stages them under .forge/triage/<tag>/
 * for the designer's own agent session (the `triage` skill) to group and
 * de-duplicate. No model call — the CLI only fetches and stages.
 */
export async function stageTriage(options: {
  tag: string;
  cwd?: string;
  log?: (line: string) => void;
}): Promise<TriageStageResult> {
  const log = options.log ?? (() => {});
  const { root, api, snapshotId } = await resolveSnapshot(options.tag, options.cwd);

  const comments = await fetchUnfetchedComments(api, snapshotId);
  if (comments.length === 0) return { staged: null, count: 0 };

  const stagedAbs = triageCommentsPath(root, options.tag);
  await fs.mkdir(path.dirname(stagedAbs), { recursive: true });
  await fs.writeFile(stagedAbs, `${JSON.stringify(comments, null, 2)}\n`, "utf8");
  log(`Staged ${comments.length} comment(s) for triage.`);
  return {
    staged: path.join(".forge", "triage", options.tag, "comments.json"),
    count: comments.length,
  };
}

export interface TriageItemInput {
  commentId: string;
  disposition: "accepted" | "declined" | "deferred" | "pending";
  /** link to an existing TASK-###, instead of creating one (accepted only) */
  taskId?: string;
  /** required for a fresh "accepted" item when taskId isn't given */
  taskTitle?: string;
  /** required for "declined" — must already exist in decisions/ */
  ddrId?: string;
}

function isDisposition(value: unknown): value is TriageItemInput["disposition"] {
  return (
    value === "accepted" || value === "declined" || value === "deferred" || value === "pending"
  );
}

const EMPTY_TODOS: LedgerDocument = {
  preambleBlocks: [],
  sections: TASK_SECTIONS.map((heading) => ({ heading, headingLine: `## ${heading}`, blocks: [] })),
  trailingNewline: true,
};
export interface TriageApplyResult {
  /** repo-relative path to the applied-batch summary */
  staged: string;
  /** comments marked fetched */
  count: number;
  feedbackIds: string[];
  taskIds: string[];
  /** comment ids the proposal didn't disposition — not written anywhere */
  skipped: string[];
}

/**
 * Writes every staged comment into the bundle's feedback/ with the disposition the
 * designer's agent session (the `triage` skill) decided — accepted → a new
 * or existing TASK-###, declined → an existing DDR-###, deferred/pending →
 * no link (spec/format.md §4) — then marks the batch fetched. A comment the
 * proposal doesn't mention is skipped, not silently dropped.
 */
export async function applyTriage(options: {
  tag: string;
  cwd?: string;
  log?: (line: string) => void;
}): Promise<TriageApplyResult> {
  const log = options.log ?? (() => {});
  const { root, api, snapshotId } = await resolveSnapshot(options.tag, options.cwd);

  let comments: ApiComment[];
  try {
    comments = JSON.parse(await fs.readFile(triageCommentsPath(root, options.tag), "utf8"));
  } catch {
    throw new Error(
      `no staged comments found at .forge/triage/${options.tag}/comments.json — run ` +
        `\`forge comments triage ${options.tag}\` first.`,
    );
  }

  let rawItems: unknown;
  try {
    rawItems = (
      JSON.parse(await fs.readFile(triageProposalJsonPath(root, options.tag), "utf8")) as {
        items?: unknown;
      }
    ).items;
  } catch {
    throw new Error(
      `no triage proposal found at .forge/triage/${options.tag}/proposal.json — disposition these ` +
        "comments in your agent session first, then rerun `forge comments triage apply`.",
    );
  }
  if (!Array.isArray(rawItems)) throw new Error('proposal.json must have an "items" array');
  const items = rawItems as Partial<TriageItemInput>[];

  const freezes = await readFreezes(root).catch(() => []);
  const freezeIndex = freezes.findIndex((f) => f.tag === options.tag);
  const freezeId =
    freezeIndex >= 0 ? `FREEZE-${String(freezeIndex + 1).padStart(3, "0")}` : undefined;

  const target = await openTriageTarget(root);
  const { todosDoc, decisionIds } = target;

  const today = todayIsoDate();
  const feedbackIds: string[] = [];
  const taskIds: string[] = [];
  const skipped: string[] = [];

  for (const comment of comments) {
    const item = items.find((candidate) => candidate.commentId === comment.id);
    if (!item || !isDisposition(item.disposition)) {
      skipped.push(comment.id);
      log(
        `skipped comment ${comment.id} (${comment.author_label}) — no disposition in proposal.json`,
      );
      continue;
    }

    const feedbackId = target.nextFeedbackId();
    let link: string | undefined;

    if (item.disposition === "accepted") {
      let taskId = item.taskId;
      if (taskId) {
        if (!findTask(todosDoc, taskId)) {
          throw new Error(
            `comment ${comment.id}: proposal references ${taskId}, which doesn't exist in the task ledger`,
          );
        }
      } else {
        if (!item.taskTitle) {
          throw new Error(
            `comment ${comment.id}: "accepted" disposition needs either taskId or taskTitle`,
          );
        }
        taskId = nextTaskEntryId(todosDoc);
        addTaskEntry(todosDoc, "Todo", {
          id: taskId,
          title: item.taskTitle,
          status: "todo",
          // Today, deliberately: the feedback arrived when it arrived, but the
          // work is only being taken on now.
          opened: today,
          genesis: feedbackId,
        });
      }
      taskIds.push(taskId);
      link = taskId;
    } else if (item.disposition === "declined") {
      if (!item.ddrId) throw new Error(`comment ${comment.id}: "declined" disposition needs ddrId`);
      if (!decisionIds.has(item.ddrId)) {
        throw new Error(
          `comment ${comment.id}: proposal references ${item.ddrId}, which doesn't exist in decisions/`,
        );
      }
      link = item.ddrId;
    }

    await target.writeFeedback({
      id: feedbackId,
      // When the feedback arrived, not when we got around to filing it (T-258).
      date: arrivalDate(comment.created_at, today),
      source: "review",
      sourceDetail: freezeId,
      from: comment.author_label,
      quote: comment.body,
      status: item.disposition,
      link,
      commentId: comment.id,
      scenarioId: comment.scenario_id ?? undefined,
      stepId: comment.step_id ?? undefined,
      route: comment.route ?? undefined,
      selector: comment.selector ?? undefined,
    });
    feedbackIds.push(feedbackId);
  }

  await target.save();
  await writeBundleIndex(root);

  const summaryAbs = triageSummaryPath(root, options.tag);
  await fs.mkdir(path.dirname(summaryAbs), { recursive: true });
  await fs.writeFile(
    summaryAbs,
    `${[
      `# Triage applied — ${options.tag}`,
      "",
      `${feedbackIds.length} feedback item(s): ${feedbackIds.join(", ") || "none"}`,
      `${taskIds.length} new/linked task(s): ${taskIds.join(", ") || "none"}`,
      skipped.length > 0
        ? `${skipped.length} comment(s) skipped (no disposition): ${skipped.join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n")}\n`,
    "utf8",
  );

  log("Marking comments fetched…");
  try {
    await markCommentsFetched(
      api,
      snapshotId,
      comments.map((c) => c.id),
    );
  } catch (error) {
    log(
      `warning: the record was updated but comments not marked fetched (${error instanceof Error ? error.message : String(error)}); a re-pull of ${options.tag} may duplicate these ${comments.length} item(s).`,
    );
  }

  return {
    staged: path.join(".forge", "triage", options.tag, "proposal.md"),
    count: comments.length,
    feedbackIds,
    taskIds,
    skipped,
  };
}

export function registerCommentsCommand(program: Command): void {
  const comments = program.command("comments").description("stakeholder comment operations");
  comments
    .command("archive")
    .argument("<tag>", "freeze tag whose snapshot should become read-only")
    .description("archive a snapshot: pins stay visible on the preview, new comments are refused")
    .action(async (tag: string) => {
      const result = await archiveTag({ tag });
      console.log(
        result.alreadyArchived
          ? `Snapshot for "${tag}" was already archived.`
          : `Archived "${tag}" — its preview is now read-only.`,
      );
    });

  comments
    .command("window")
    .argument("<tag>", "freeze tag whose feedback round has a deadline")
    .option("--closes <date>", "when the round stops taking comments (YYYY-MM-DD, or with a time)")
    .option("--clear", "remove the deadline and leave the round open-ended")
    .description("set, extend or clear the feedback window on a freeze")
    .action(async (tag: string, options: { closes?: string; clear?: boolean }) => {
      if (options.clear && options.closes) {
        throw new Error("pass either --closes or --clear, not both");
      }
      if (!options.clear && !options.closes) {
        throw new Error("pass --closes <date> to set a deadline, or --clear to remove one");
      }
      const result = await setWindow({
        tag,
        closes: options.clear ? null : (options.closes ?? ""),
      });
      if (!result.closesAt) {
        console.log(`Cleared the feedback window on "${tag}" — the round is open-ended again.`);
        return;
      }
      // Echoed in the creator's own zone and in UTC: they typed the first and
      // their reviewers are shown the second.
      console.log(
        `Feedback on "${tag}" closes ${new Date(result.closesAt).toLocaleString()} ` +
          `(${result.closesAt}).`,
      );
      console.log(
        "Reviewers see the deadline in the review banner. Extend it by running this again.",
      );
    });

  comments
    .command("resolve")
    .argument("<tag>", "the release that ships the addressed work")
    .description(
      'tell every earlier snapshot what became of its comments: declined ones carry the DDR, accepted ones whose task is done become "addressed in <tag>"',
    )
    .action(async (tag: string) => {
      const result = await resolveTrail({ tag, log: console.log });
      for (const warning of result.warnings) console.log(`warning: ${warning}`);
      if (result.addressed === 0 && result.declined === 0) {
        console.log("Nothing to resolve — no settled review feedback to project.");
        return;
      }
      console.log(
        `Resolved ${result.synced} comment(s): ${result.addressed} addressed in ${tag}` +
          (result.declined > 0 ? `, ${result.declined} declined` : "") +
          ". Old share links now show where each one landed.",
      );
    });

  const triage = comments
    .command("triage")
    .description(
      "stage and apply comment triage into the record's feedback/ and todos.md (spec/format.md)",
    );

  triage
    .argument("<tag>", "freeze tag whose comments to triage")
    .description(
      "stage new comments under .forge/triage/<tag>/ for disposition in your agent session",
    )
    .action(async (tag: string) => {
      const result = await stageTriage({ tag, log: console.log });
      if (result.count === 0) {
        console.log("Nothing to triage — no unfetched comments.");
        return;
      }
      console.log(
        `Staged ${result.count} comment(s) at ${result.staged}. Disposition them with the triage skill ` +
          `in your agent session, then run \`forge comments triage apply ${tag}\`.`,
      );
    });

  triage
    .command("apply")
    .argument("<tag>", "freeze tag whose staged comments to apply")
    .description(
      "write each staged comment's disposition (.forge/triage/<tag>/proposal.json) into feedback/ and todos.md, then mark them fetched",
    )
    .action(async (tag: string) => {
      const result = await applyTriage({ tag, log: console.log });
      console.log(
        `Applied ${result.count} comment(s) → ${result.feedbackIds.length} FEEDBACK item(s)` +
          (result.taskIds.length > 0 ? `, ${result.taskIds.length} task(s)` : "") +
          (result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : "") +
          `. Summary at ${result.staged}.`,
      );
    });
}

/**
 * Where triage writes, for whichever format version this record is on.
 *
 * v0.1 appends rows to Feedbacks.md and Todos.md; v0.2 writes one concept file
 * per feedback item and keeps the task ledger inside `design/todos.md` (tasks
 * stay a ledger, DDR-060). The disposition rules above are identical either
 * way — only the shape on disk differs.
 */
interface TriageTarget {
  todosDoc: LedgerDocument;
  decisionIds: Set<string>;
  nextFeedbackId(): string;
  writeFeedback(input: {
    id: string;
    date: string;
    source: "review";
    sourceDetail?: string;
    from: string;
    quote: string;
    status: string;
    link?: string;
    /** the service comment this feedback came from — what the trail syncs on */
    commentId: string;
    /** the scenario and flow step it was written under, when guided */
    scenarioId?: string;
    stepId?: string;
    /** where on the prototype it was written — a designer's first question */
    route?: string;
    selector?: string;
  }): Promise<void>;
  save(): Promise<void>;
}

async function openTriageTarget(root: string): Promise<TriageTarget> {
  // DDR-095: triage writes into the bundle and nowhere else. The root-file
  // `Todos.md`/`Feedbacks.md` writer left with the format it served.
  const { recordRoot } = await requireCurrentRecord(root);
  const bundle = await scanBundle(root, { recordRoot });

  const bundleRoot = path.join(root, recordRoot);
  const todosConcept = bundle.concepts.find((c) => c.type === "Task Ledger");
  const todosDoc = todosConcept ? parseTodos(todosConcept.body) : EMPTY_TODOS;
  const allocated: string[] = bundle.concepts.flatMap((c) =>
    c.type === "Feedback" && c.id ? [c.id] : [],
  );

  return {
    todosDoc,
    decisionIds: new Set(
      bundle.concepts.flatMap((c) => (c.type === "Decision" && c.id ? [c.id] : [])),
    ),
    nextFeedbackId() {
      const id = nextId(allocated, "FEEDBACK");
      allocated.push(id);
      return id;
    },
    async writeFeedback(input) {
      const relPath = path.join("feedback", `${input.id}.md`);
      await fs.mkdir(path.join(bundleRoot, "feedback"), { recursive: true });
      await fs.writeFile(
        path.join(bundleRoot, relPath),
        withFrontmatter(
          {
            type: "Feedback",
            id: input.id,
            title: oneLine(input.quote).slice(0, 120),
            date: input.date,
            feedback_status: input.status,
            source: input.source,
            freeze: input.sourceDetail,
            from: input.from,
            resolution: input.link,
            // The trail syncs on this: without it the record knows what it
            // decided and has no way to tell the person who asked (T-294).
            comment: input.commentId,
            scenario: input.scenarioId,
            step: input.stepId,
            // "where was this" is the first thing anyone asks of a comment,
            // and the staged comment has carried both all along (TASK-324).
            route: input.route,
            selector: input.selector,
          },
          `> ${oneLine(input.quote)}\n`,
        ),
        "utf8",
      );
    },
    async save() {
      const todosPath = path.join(bundleRoot, "todos.md");
      const current =
        todosConcept?.raw ??
        withFrontmatter({ type: "Task Ledger", title: "Todos" }, serializeTodos(EMPTY_TODOS));
      await fs.writeFile(todosPath, setBody(current, serializeTodos(todosDoc)), "utf8");
    },
  };
}
