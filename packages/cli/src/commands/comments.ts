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
  downloadScreenshot,
  fetchUnfetchedComments,
  markCommentsFetched,
} from "../comments-client.js";
import { readUserConfig } from "../config.js";
import { findFreeze, readFreezes, todayIsoDate } from "../freezes.js";
import { requireRepoRoot } from "../git.js";
import { readRecordVersion, requireCurrentRecord, versionRefusal } from "../record-version.js";
import { resolveTrail } from "../resolution-trail.js";
import { addTask, nextTaskId, parseTodo, serializeTodo, type TaskField } from "../todo.js";

export interface PullOptions {
  tag: string;
  cwd?: string;
  log?: (line: string) => void;
}

export interface PullResult {
  /** todo items created (one per thread root) */
  created: number;
  /** comments marked fetched server-side (roots + replies) */
  fetched: number;
  screenshots: number;
}

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
 * One groomed todo item per thread root; replies fold into the item as
 * `reply:` field lines. Spec §2 fields: quote, route, selector, screenshot
 * (downloaded into artifacts/feedback/<tag>/), author, timestamp.
 */
function taskFields(
  root: ApiComment,
  replies: ApiComment[],
  screenshotPath: string | null,
  tag: string,
): TaskField[] {
  const fields: TaskField[] = [{ key: "quote", value: `"${oneLine(root.body)}"` }];
  if (root.route) fields.push({ key: "route", value: root.route });
  if (root.selector) fields.push({ key: "selector", value: root.selector });
  // What the reviewer was doing, when the review was a guided pass (T-297):
  // "this broke while approving" reads very differently from "this broke".
  if (root.scenario_id) fields.push({ key: "scenario", value: root.scenario_id });
  if (root.step_id) fields.push({ key: "step", value: root.step_id });
  if (screenshotPath) fields.push({ key: "screenshot", value: screenshotPath });
  // Preserve the release association even when a screenshot was unavailable.
  fields.push({ key: "tag", value: tag });
  fields.push({ key: "author", value: root.author_label });
  fields.push({ key: "timestamp", value: root.created_at });
  for (const reply of replies) {
    fields.push({ key: "reply", value: `"${oneLine(reply.body)}" — ${reply.author_label}` });
  }
  fields.push({ key: "notes", value: "" });
  return fields;
}

/** Shared plumbing: repo root, API config, and the tag's registered snapshot. */
async function resolveSnapshot(
  tag: string,
  cwd?: string,
): Promise<{ root: string; api: CommentsApiConfig; snapshotId: string }> {
  const root = await requireRepoRoot(cwd);

  const userConfig = await readUserConfig();
  if (!userConfig.commentsApiUrl || !userConfig.commentsApiKey) {
    throw new Error(
      "comment API not configured — set commentsApiUrl and commentsApiKey in ~/.forge/config.json",
    );
  }
  const api: CommentsApiConfig = {
    apiUrl: userConfig.commentsApiUrl,
    apiKey: userConfig.commentsApiKey,
  };

  const freeze = findFreeze(await readFreezes(root), tag);
  if (!freeze) throw new Error(`no freeze named "${tag}" in freezes.json`);
  if (!freeze.snapshotId) {
    throw new Error(
      `freeze "${tag}" has no registered snapshot — it was made without the comment API configured`,
    );
  }
  return { root, api, snapshotId: freeze.snapshotId };
}

export async function pullComments(options: PullOptions): Promise<PullResult> {
  const log = options.log ?? (() => {});
  const { root, api, snapshotId } = await resolveSnapshot(options.tag, options.cwd);

  // `pull` writes the v1 ledger — `todo/todo.md`, `T-###` ids, screenshots into
  // `artifacts/feedback/` — and never learned any other layout. On a current
  // record it used to fail at the read with a raw ENOENT naming a path the user
  // has no reason to expect (TASK-384). It refuses here instead, and it refuses
  // *before* fetching, because the comments are consumed once: the failure has
  // to leave them unfetched for triage to find.
  const version = await readRecordVersion(root);
  if (version.kind === "current") {
    throw new Error(
      "`forge comments pull` writes the pre-0.2 ledger (todo/todo.md) and has no path into the " +
        `bundle — use \`forge comments triage ${options.tag}\` instead, which stages the same ` +
        "comments for disposition and writes Feedback concepts with a resolution trail.",
    );
  }
  if (version.kind !== "migratable") throw new Error(versionRefusal(version));

  log(`Fetching unfetched comments for ${options.tag}…`);
  const comments = await fetchUnfetchedComments(api, snapshotId);
  if (comments.length === 0) {
    log("No unfetched comments.");
    return { created: 0, fetched: 0, screenshots: 0 };
  }

  const roots = comments.filter((c) => !c.parent_id);
  const repliesByParent = new Map<string, ApiComment[]>();
  for (const comment of comments) {
    if (!comment.parent_id) continue;
    const list = repliesByParent.get(comment.parent_id) ?? [];
    list.push(comment);
    repliesByParent.set(comment.parent_id, list);
  }

  const todoPath = path.join(root, "todo", "todo.md");
  const doc = parseTodo(await fs.readFile(todoPath, "utf8"));
  const feedbackDir = path.join(root, "artifacts", "feedback", options.tag);

  let screenshots = 0;
  for (const comment of roots) {
    let screenshotPath: string | null = null;
    if (comment.screenshot_url) {
      await fs.mkdir(feedbackDir, { recursive: true });
      const relPath = path.join("artifacts", "feedback", options.tag, `${comment.id}.png`);
      await fs.writeFile(
        path.join(root, relPath),
        await downloadScreenshot(comment.screenshot_url),
      );
      screenshotPath = relPath;
      screenshots += 1;
    }
    const title = oneLine(comment.body).slice(0, 80) || "Stakeholder comment";
    addTask(doc, `Inbox — ${options.tag}`, {
      id: nextTaskId(doc),
      title,
      fields: taskFields(
        comment,
        repliesByParent.get(comment.id) ?? [],
        screenshotPath,
        options.tag,
      ),
    });
  }
  await fs.writeFile(todoPath, serializeTodo(doc), "utf8");

  // Mark fetched only after the local write succeeds (at-least-once): if the
  // mark fails, the comments are safely in the Inbox and a re-pull would re-add
  // them — warn rather than mark-before-save, which could silently drop them.
  log("Marking comments fetched…");
  try {
    await markCommentsFetched(
      api,
      snapshotId,
      comments.map((c) => c.id),
    );
  } catch (error) {
    log(
      `warning: comments saved to todo.md but not marked fetched (${error instanceof Error ? error.message : String(error)}); a re-pull of ${options.tag} may duplicate these ${comments.length} item(s).`,
    );
  }

  return { created: roots.length, fetched: comments.length, screenshots };
}

export async function archiveTag(options: {
  tag: string;
  cwd?: string;
}): Promise<{ alreadyArchived: boolean }> {
  const { api, snapshotId } = await resolveSnapshot(options.tag, options.cwd);
  return archiveSnapshot(api, snapshotId);
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
    .command("pull")
    .argument("<tag>", "freeze tag to pull comments for")
    .description(
      "fetch new stakeholder comments into todo.md under `## Inbox — <tag>` (screenshots land in artifacts/feedback/<tag>/) and mark them fetched",
    )
    .action(async (tag: string) => {
      const result = await pullComments({ tag, log: console.log });
      if (result.created === 0) {
        console.log("Inbox unchanged — no unfetched comments.");
        return;
      }
      console.log(
        `Pulled ${result.fetched} comment(s) into ${result.created} todo item(s) under "Inbox — ${tag}"` +
          (result.screenshots > 0 ? ` with ${result.screenshots} screenshot(s)` : "") +
          ". Review and commit todo.md when groomed.",
      );
    });

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
