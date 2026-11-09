import { promises as fs } from "node:fs";
import path from "node:path";
import {
  addTask as addTaskEntry,
  findTask,
  type LedgerDocument,
  type NewTaskInput,
  nextId,
  nextTaskId as nextTaskEntryId,
  type ParsedConcept,
  parseTodos,
  scanBundle,
  serializeTodos,
  TASK_SECTIONS,
  withFrontmatter,
} from "@forgedesign/format";
import { writeNewFile } from "./atomic-write.js";
import { writeBundleIndex } from "./bundle-index.js";
import {
  type ApiComment,
  archiveSnapshot,
  type CommentsApiConfig,
  commentsApiFor,
  fetchUnfetchedComments,
  markCommentsFetched,
  setSnapshotWindow,
} from "./comments-client.js";
import { type ImportSource, readImportedBatch } from "./comments-import.js";
import { readUserConfig } from "./config.js";
import { findFreeze, localIsoDate, readFreezes, todayIsoDate } from "./freezes.js";
import { requireRepoRoot } from "./git.js";
import { requireCurrentRecord } from "./record-version.js";
import { type PendingTask, saveLedgerAdditions } from "./task-ledger.js";

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
  return Number.isNaN(parsed.getTime()) ? fallback : localIsoDate(parsed);
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
  /** staged comments their authors withdrew, and what each already became (DDR-165) */
  withdrawn: Withdrawal[];
}

/**
 * A comment its author withdrew (DDR-165), and the FEEDBACK or QUESTION the
 * record already made of it — null when the record never took it in, because
 * it was withdrawn before a pull or skipped by an earlier triage.
 */
export interface Withdrawal {
  commentId: string;
  conceptId: string | null;
}

/**
 * Which concept each service comment became, read from the `comment:` field
 * triage writes on every Feedback and Question it files. This is how a
 * withdrawal finds the item it concerns without the record deleting anything.
 */
function conceptsByComment(concepts: readonly ParsedConcept[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const concept of concepts) {
    const commentId = concept.frontmatter.comment;
    if ((concept.type === "Feedback" || concept.type === "Question") && concept.id) {
      if (typeof commentId === "string") found.set(commentId, concept.id);
    }
  }
  return found;
}

/** One line per withdrawal, naming what the record holds for it. */
function describeWithdrawals(withdrawals: readonly Withdrawal[]): string[] {
  return withdrawals.map(
    (w) =>
      `  ${w.conceptId ?? "not in the record"} — comment ${w.commentId} was withdrawn by its author`,
  );
}

const triageCommentsPath = (root: string, tag: string) =>
  path.join(root, ".forge", "triage", tag, "comments.json");
const triageProposalJsonPath = (root: string, tag: string) =>
  path.join(root, ".forge", "triage", tag, "proposal.json");
const triageSummaryPath = (root: string, tag: string) =>
  path.join(root, ".forge", "triage", tag, "proposal.md");

/**
 * Fetches new comments for `tag` and stages them under .forge/triage/<tag>/
 * for the designer's own agent session (the `forge-triage` skill) to group and
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
  if (comments.length === 0) return { staged: null, count: 0, withdrawn: [] };

  const stagedAbs = triageCommentsPath(root, options.tag);
  await fs.mkdir(path.dirname(stagedAbs), { recursive: true });
  await fs.writeFile(stagedAbs, `${JSON.stringify(comments, null, 2)}\n`, "utf8");
  const questions = comments.filter((comment) => comment.kind === "question").length;
  log(
    `Staged ${comments.length} comment(s)${questions > 0 ? ` — ${questions} of them question(s)` : ""} for triage.`,
  );
  const withdrawn = await withdrawalsIn(root, comments);
  if (withdrawn.length > 0) {
    log(
      `${withdrawn.length} of them withdrawn by their authors (DDR-165). Apply files nothing for these, and the record keeps what it already holds; what a withdrawal means for it is your call:`,
    );
    for (const line of describeWithdrawals(withdrawn)) log(line);
  }
  return {
    staged: path.join(".forge", "triage", options.tag, "comments.json"),
    count: comments.length,
    withdrawn,
  };
}

/**
 * The staged comments their authors withdrew, each with what the record made
 * of it. Staging never needed the record before, so a record this cannot read
 * costs the names, not the stage: the withdrawals are still listed, as not in
 * the record, and `triage apply` reads the record properly or refuses.
 */
async function withdrawalsIn(root: string, comments: ApiComment[]): Promise<Withdrawal[]> {
  const withdrawn = comments.filter((comment) => comment.status === "withdrawn");
  if (withdrawn.length === 0) return [];
  let filed = new Map<string, string>();
  try {
    const { recordRoot } = await requireCurrentRecord(root);
    filed = conceptsByComment((await scanBundle(root, { recordRoot })).concepts);
  } catch {
    // listed below as not in the record
  }
  return withdrawn.map((comment) => ({
    commentId: comment.id,
    conceptId: filed.get(comment.id) ?? null,
  }));
}

/** What a comment can become: feedback with one of the record's five states. */
const FEEDBACK_DISPOSITIONS = ["accepted", "declined", "deferred", "pending"] as const;
/**
 * What a question can become (TASK-462): answered by something already in the
 * record, left open as a Question of its own, or declined with the decision
 * that declines it. There is no `pending` for a question — `open` is that.
 */
const QUESTION_DISPOSITIONS = ["answered", "open", "declined"] as const;

type FeedbackDisposition = (typeof FEEDBACK_DISPOSITIONS)[number];
type QuestionDisposition = (typeof QUESTION_DISPOSITIONS)[number];

export interface TriageItemInput {
  commentId: string;
  disposition: FeedbackDisposition | QuestionDisposition;
  /** link to an existing TASK-###, instead of creating one (accepted only) */
  taskId?: string;
  /** required for a fresh "accepted" item when taskId isn't given */
  taskTitle?: string;
  /** required for "declined" — must already exist in decisions/ */
  ddrId?: string;
  /** required for a question dispositioned "answered": the DDR, FEEDBACK, TASK or QUESTION that answers it */
  answerId?: string;
}

function isDisposition(value: unknown): value is TriageItemInput["disposition"] {
  return isFeedbackDisposition(value) || isQuestionDisposition(value);
}

function isFeedbackDisposition(value: unknown): value is FeedbackDisposition {
  return (FEEDBACK_DISPOSITIONS as readonly unknown[]).includes(value);
}

function isQuestionDisposition(value: unknown): value is QuestionDisposition {
  return (QUESTION_DISPOSITIONS as readonly unknown[]).includes(value);
}

/** A fresh one each time: triage adds to the ledger it opens, and a shared constant would carry one run's tasks into the next. */
const emptyTodos = (): LedgerDocument => ({
  preambleBlocks: [],
  sections: TASK_SECTIONS.map((heading) => ({ heading, headingLine: `## ${heading}`, blocks: [] })),
  trailingNewline: true,
});
export interface TriageApplyResult {
  /** repo-relative path to the applied-batch summary */
  staged: string;
  /** comments marked fetched */
  count: number;
  feedbackIds: string[];
  taskIds: string[];
  /** QUESTION-### concepts written from the batch's questions (TASK-462) */
  questionIds: string[];
  /** comment ids the proposal didn't disposition — not written anywhere */
  skipped: string[];
  /** comments their authors withdrew: nothing written for them, the record left as it was */
  withdrawn: Withdrawal[];
}

/**
 * Writes every staged comment into the bundle's feedback/ with the disposition the
 * designer's agent session (the `forge-triage` skill) decided — accepted → a new
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
  const root = await requireRepoRoot(options.cwd);
  // An imported batch (TASK-463) has no snapshot and no service to mark
  // fetched; its manifest says where it came from, and that is the feedback's
  // `source`. A Cloud batch is the tag's registered snapshot, as before.
  const imported = await readImportedBatch(root, options.tag);
  const cloud = imported === null ? await resolveSnapshot(options.tag, options.cwd) : null;

  let comments: ApiComment[];
  try {
    comments = JSON.parse(await fs.readFile(triageCommentsPath(root, options.tag), "utf8"));
  } catch {
    throw new Error(
      `no staged comments found at .forge/triage/${options.tag}/comments.json — run ` +
        `\`forge comments triage ${options.tag}\` (or \`forge comments import …\`) first.`,
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
  if (cloud) await refuseChangedSinceStaging(cloud, comments, options.tag, log);

  const freezes = await readFreezes(root).catch(() => []);
  // An imported batch names the freeze it was about only if the creator said
  // so; a Cloud batch *is* a freeze's.
  const freezeTag = imported ? imported.freeze : options.tag;
  const freezeIndex = freezes.findIndex((f) => f.tag === freezeTag);
  const freezeId =
    freezeIndex >= 0 ? `FREEZE-${String(freezeIndex + 1).padStart(3, "0")}` : undefined;
  if (imported?.freeze && freezeId === undefined) {
    throw new Error(
      `batch ${options.tag} says it was about freeze "${imported.freeze}", which is not in freezes.json`,
    );
  }

  const target = await openTriageTarget(root);
  const { todosDoc, decisionIds } = target;

  const today = todayIsoDate();
  const feedbackIds: string[] = [];
  const taskIds: string[] = [];
  const questionIds: string[] = [];
  const skipped: string[] = [];
  const withdrawn: Withdrawal[] = [];
  // Every item is validated before any concept is written: a bad id in the
  // last item must not leave the first three on disk with the ledger unsaved.
  // The skill has promised that all along; the loop used to write as it went.
  const writes: Array<() => Promise<void>> = [];

  for (const comment of comments) {
    const item = items.find((candidate) => candidate.commentId === comment.id);
    // Its author took it back (DDR-165). It has no words to file, and what it
    // already became stays as it is: the record is never edited by a pull, and
    // the creator decides what the withdrawal means for that item. Marked
    // fetched with the rest, so the next pull does not carry it again.
    if (comment.status === "withdrawn") {
      withdrawn.push({
        commentId: comment.id,
        conceptId: target.conceptByComment.get(comment.id) ?? null,
      });
      if (item) log(`ignored the disposition for comment ${comment.id}: its author withdrew it`);
      continue;
    }
    if (!item || !isDisposition(item.disposition)) {
      skipped.push(comment.id);
      log(
        `skipped comment ${comment.id} (${comment.author_label}) — no disposition in proposal.json`,
      );
      continue;
    }

    // What every concept filed from this comment carries, whichever kind it is.
    const provenance = {
      // When it arrived, not when we got around to filing it (T-258).
      date: arrivalDate(comment.created_at, today),
      sourceDetail: freezeId,
      from: comment.author_label,
      quote: comment.body,
      scenarioId: comment.scenario_id ?? undefined,
      stepId: comment.step_id ?? undefined,
      route: comment.route ?? undefined,
      selector: comment.selector ?? undefined,
    };

    // A question becomes a Question concept, never feedback (TASK-462): it
    // asked to be answered, not acted on, and the two have different states.
    // The kind comes from the service; a proposal cannot reclassify it.
    if (comment.kind === "question") {
      const disposition = item.disposition;
      if (!isQuestionDisposition(disposition)) {
        throw new Error(
          `comment ${comment.id} is a question — disposition it "answered" (with answerId), "open", or "declined" (with ddrId), not "${disposition}"`,
        );
      }
      let status: "open" | "resolved" | "dropped" = "open";
      let link: string | undefined;
      if (disposition === "answered") {
        if (!item.answerId) {
          throw new Error(
            `comment ${comment.id}: "answered" needs answerId — the DDR, FEEDBACK, TASK or QUESTION in the record that answers it`,
          );
        }
        const known = item.answerId.startsWith("TASK-")
          ? Boolean(findTask(todosDoc, item.answerId))
          : target.conceptIds.has(item.answerId);
        if (!known) {
          throw new Error(
            `comment ${comment.id}: proposal references ${item.answerId}, which is not in the record`,
          );
        }
        status = "resolved";
        link = item.answerId;
      } else if (disposition === "declined") {
        status = "dropped";
        link = declinedBy(comment, item, decisionIds);
      }
      const questionId = target.nextQuestionId();
      const resolution = link;
      writes.push(() =>
        target.writeConcept({
          type: "Question",
          id: questionId,
          status,
          link: resolution,
          // A question always came through the review, and always names its comment.
          source: "review",
          commentId: comment.id,
          ...provenance,
        }),
      );
      questionIds.push(questionId);
      continue;
    }
    if (!isFeedbackDisposition(item.disposition)) {
      throw new Error(
        `comment ${comment.id} is a comment — disposition it accepted, declined, deferred or pending, not "${item.disposition}" (that is a question's disposition)`,
      );
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
        target.addTask({
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
      link = declinedBy(comment, item, decisionIds);
    }

    const disposition = item.disposition;
    const resolution = link;
    writes.push(() =>
      target.writeConcept({
        type: "Feedback",
        id: feedbackId,
        status: disposition,
        link: resolution,
        source: imported?.source ?? "review",
        // The service id is the link back for the trail; an import's link
        // back is the URL where the comment lives.
        commentId: imported ? undefined : comment.id,
        url: comment.url ?? undefined,
        ...provenance,
      }),
    );
    feedbackIds.push(feedbackId);
  }

  // The ledger first: it is the write that can refuse (a task id taken while
  // this ran), and refusing before any feedback concept exists leaves nothing
  // pointing at a task that was never filed.
  await target.save();
  for (const write of writes) await write();
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
      questionIds.length > 0 ? `${questionIds.length} question(s): ${questionIds.join(", ")}` : "",
      skipped.length > 0
        ? `${skipped.length} comment(s) skipped (no disposition): ${skipped.join(", ")}`
        : "",
      withdrawn.length > 0
        ? [
            `${withdrawn.length} comment(s) withdrawn by their authors, nothing written:`,
            ...describeWithdrawals(withdrawn),
          ].join("\n")
        : "",
    ]
      .filter(Boolean)
      .join("\n")}\n`,
    "utf8",
  );

  if (cloud) {
    log("Marking comments fetched…");
    try {
      await markCommentsFetched(
        cloud.api,
        cloud.snapshotId,
        comments.map((c) => c.id),
      );
    } catch (error) {
      log(
        `warning: the record was updated but comments not marked fetched (${error instanceof Error ? error.message : String(error)}); a re-pull of ${options.tag} may duplicate these ${comments.length} item(s).`,
      );
    }
  }

  return {
    staged: path.join(".forge", "triage", options.tag, "proposal.md"),
    count: comments.length,
    feedbackIds,
    taskIds,
    questionIds,
    skipped,
    withdrawn,
  };
}

/**
 * Refuses a staged batch whose comments changed on the review since they were
 * staged (DDR-165). Staging does not stamp `fetched_at`; apply does, so until
 * apply a stakeholder may still edit or delete what was staged, and filing the
 * staged copy would put in the record words their author changed or took back.
 * A comment no longer unfetched is refused too: deleted, or already applied,
 * which would file it twice. Before anything is written, like every other
 * refusal here. A review that cannot be reached is said and not fatal, as a
 * failed mark-fetched is not: the creator may be applying offline.
 */
async function refuseChangedSinceStaging(
  cloud: { api: CommentsApiConfig; snapshotId: string },
  staged: readonly ApiComment[],
  tag: string,
  log: (line: string) => void,
): Promise<void> {
  let current: Map<string, ApiComment>;
  try {
    const now = await fetchUnfetchedComments(cloud.api, cloud.snapshotId);
    current = new Map(now.map((comment) => [comment.id, comment]));
  } catch (error) {
    log(
      `warning: could not check the staged comments against the review (${error instanceof Error ? error.message : String(error)}); applying them as staged.`,
    );
    return;
  }
  const changed = staged.filter((comment) => {
    const now = current.get(comment.id);
    return (
      !now ||
      now.body !== comment.body ||
      (now.status ?? "open") !== (comment.status ?? "open") ||
      (now.edited_at ?? null) !== (comment.edited_at ?? null)
    );
  });
  if (changed.length === 0) return;
  throw new Error(
    `${changed.length} staged comment(s) changed on the review since they were staged — edited, ` +
      `deleted or withdrawn by their authors, or already applied: ${changed.map((c) => c.id).join(", ")}. ` +
      `Run \`forge comments triage ${tag}\` again and disposition the fresh batch; nothing was written.`,
  );
}

/**
 * A staged comment as a concept (TASK-543): Feedback for a comment, a Question
 * for a question (TASK-462). The two carry the same provenance — who, when,
 * which freeze, where on the prototype — and differ in where they live and
 * what their status field is called. They were two writers, field for field
 * the same apart from those, and one had already drifted: a Question listed
 * `resolution` in a different place.
 */
interface StakeholderConcept {
  type: "Feedback" | "Question";
  id: string;
  date: string;
  status: string;
  link?: string;
  source: "review" | ImportSource;
  sourceDetail?: string;
  from: string;
  quote: string;
  /** the service comment it came from — what the trail syncs on; none for an import */
  commentId?: string;
  /** where an imported comment lives at its source */
  url?: string;
  /** the scenario and flow step it was written under, when guided */
  scenarioId?: string;
  stepId?: string;
  route?: string;
  selector?: string;
}

const CONCEPT_HOMES = {
  Feedback: { dir: "feedback", statusField: "feedback_status" },
  Question: { dir: "questions", statusField: "question_status" },
} as const;

/** The decision a "declined" disposition points at, which must exist — for a comment or a question alike. */
function declinedBy(
  comment: ApiComment,
  item: Pick<TriageItemInput, "ddrId">,
  decisionIds: Set<string>,
): string {
  if (!item.ddrId) throw new Error(`comment ${comment.id}: "declined" disposition needs ddrId`);
  if (!decisionIds.has(item.ddrId)) {
    throw new Error(
      `comment ${comment.id}: proposal references ${item.ddrId}, which doesn't exist in decisions/`,
    );
  }
  return item.ddrId;
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
  /** a new Todo task: into `todosDoc` now, so the next id is allocated past it, and into the file at `save` */
  addTask(input: NewTaskInput): void;
  decisionIds: Set<string>;
  /** every concept id in the record — what a question's answer may point at */
  conceptIds: Set<string>;
  /** the concept each service comment became, by its `comment:` field (DDR-165) */
  conceptByComment: Map<string, string>;
  nextFeedbackId(): string;
  nextQuestionId(): string;
  /** a staged comment filed as the concept its kind becomes (TASK-462, TASK-543) */
  writeConcept(input: StakeholderConcept): Promise<void>;
  save(): Promise<void>;
}

async function openTriageTarget(root: string): Promise<TriageTarget> {
  // DDR-095: triage writes into the bundle and nowhere else. The root-file
  // `Todos.md`/`Feedbacks.md` writer left with the format it served.
  const { recordRoot } = await requireCurrentRecord(root);
  const bundle = await scanBundle(root, { recordRoot });

  const bundleRoot = path.join(root, recordRoot);
  const todosConcept = bundle.concepts.find((c) => c.type === "Task Ledger");
  const todosDoc = todosConcept ? parseTodos(todosConcept.body) : emptyTodos();
  const pendingTasks: PendingTask[] = [];
  const allocated: string[] = bundle.concepts.flatMap((c) =>
    c.type === "Feedback" && c.id ? [c.id] : [],
  );
  const allocatedQuestions: string[] = bundle.concepts.flatMap((c) =>
    c.type === "Question" && c.id ? [c.id] : [],
  );

  return {
    todosDoc,
    addTask(input) {
      addTaskEntry(todosDoc, "Todo", input);
      pendingTasks.push({ section: "Todo", input });
    },
    decisionIds: new Set(
      bundle.concepts.flatMap((c) => (c.type === "Decision" && c.id ? [c.id] : [])),
    ),
    conceptIds: new Set(bundle.concepts.flatMap((c) => (c.id ? [c.id] : []))),
    conceptByComment: conceptsByComment(bundle.concepts),
    nextFeedbackId() {
      const id = nextId(allocated, "FEEDBACK");
      allocated.push(id);
      return id;
    },
    nextQuestionId() {
      const id = nextId(allocatedQuestions, "QUESTION");
      allocatedQuestions.push(id);
      return id;
    },
    async writeConcept(input) {
      const home = CONCEPT_HOMES[input.type];
      await fs.mkdir(path.join(bundleRoot, home.dir), { recursive: true });
      await writeNewFile(
        path.join(bundleRoot, home.dir, `${input.id}.md`),
        withFrontmatter(
          {
            type: input.type,
            id: input.id,
            title: oneLine(input.quote).slice(0, 120),
            date: input.date,
            [home.statusField]: input.status,
            source: input.source,
            freeze: input.sourceDetail,
            from: input.from,
            resolution: input.link,
            // The trail syncs on this: without it the record knows what it
            // decided and has no way to tell the person who asked (T-294).
            comment: input.commentId,
            url: input.url,
            scenario: input.scenarioId,
            step: input.stepId,
            // "where was this" is the first thing anyone asks of a comment,
            // and the staged comment has carried both all along (TASK-324).
            route: input.route,
            selector: input.selector,
          },
          `> ${oneLine(input.quote)}\n`,
        ),
      );
    },
    async save() {
      // Merged into the ledger as it is now (TASK-536), so a task someone else
      // added since this triage opened it survives.
      await saveLedgerAdditions(
        root,
        path.join(recordRoot, "todos.md"),
        withFrontmatter({ type: "Task Ledger", title: "Todos" }, serializeTodos(emptyTodos())),
        pendingTasks,
      );
    },
  };
}
