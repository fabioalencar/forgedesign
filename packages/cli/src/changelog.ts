// `forge changelog draft` and `forge changelog apply` (DDR-176, TASK-579).
//
// The changelog is what a stakeholder is told changed, in the creator's words,
// so nothing here writes an entry on its own judgment. `draft` reads what closed
// since the last freeze and stages candidates in `.forge/changelog/<batch>.json`,
// every one of them `keep: false`; the creator (or their agent, in the freeze
// conversation) keeps the ones with UI/UX impact and rewords them for the person
// reading them; `apply` writes only those. It is the shape intake and triage
// already have — the CLI proposes, a person applies (principle 3).
//
// **Before the freeze, against the working tree.** `forge freeze` cuts its tag
// before its own commit, and the record crosses at publish from the tag's tree
// (DDR-129). An entry applied after `forge freeze v7` would reach stakeholders
// with v8. So the draft compares the last freeze's tag with the working tree —
// the version being drafted has no tag yet — and the freeze skill runs this
// step before it freezes.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type Audience,
  allEntries,
  CHANGE_STATUSES,
  type ChangeStatus,
  isAudience,
  isChangeStatus,
  nextId,
  type ParsedConcept,
  parseConcept,
  parsePageRows,
  parseTodos,
  readChange,
  scanBundle,
  setBody,
  setFrontmatterFields,
  taskView,
  withFrontmatter,
} from "@forgedesign/format";
import { writeFileAtomic, writeNewFile } from "./atomic-write.js";
import { writeBundleIndex } from "./bundle-index.js";
import { CliError } from "./cli-error.js";
import { ledgerAt } from "./feature-log.js";
import { readFreezes, todayIsoDate } from "./freezes.js";
import { requireCurrentRecord } from "./record-version.js";
import { normalizeRoute } from "./routes.js";

/** The sentence every draft carries, because the file crosses to every PIN holder. */
export const DISCLOSURE_NOTICE =
  "A change entry is visible to everyone holding the review PIN once it is published. " +
  "Keep `requested_by` and `links` only where that is fine to show; change a name to a team " +
  "or an organisation, or delete it.";

const BATCH_RE = /^[a-z0-9][a-z0-9-]*$/;

/** One candidate in a batch. `new` writes a CHANGE-###; `update` changes an existing one. */
export interface StagedChange {
  /** nothing is written unless a person sets this to true */
  keep: boolean;
  action: "new" | "update";
  /** the entry an `update` changes */
  id?: string;
  title?: string;
  /** what a reader will notice, in the creator's words */
  body?: string;
  change_status: ChangeStatus;
  routes?: string[];
  requested_by?: string | null;
  links?: string[];
  refs?: string[];
  /** set only to override the type's default (`stakeholders`) */
  audience?: Audience;
  /** why the draft proposed it; read by the person deciding, never written to the record */
  reason?: string;
}

export interface ChangelogBatch {
  kind: "forge-changelog-draft";
  createdAt: string;
  /** the freeze this compares against, or null when the record has none yet */
  since: string | null;
  notice: string;
  entries: StagedChange[];
  /** stamped by apply, so the same batch is not written twice */
  appliedAt?: string;
  applied?: string[];
}

export interface DraftResult {
  batch: string;
  /** repo-relative */
  path: string;
  since: string | null;
  entries: StagedChange[];
}

const changelogDir = (root: string) => path.join(root, ".forge", "changelog");
const batchFile = (root: string, batch: string) => path.join(changelogDir(root), `${batch}.json`);

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const unique = <T>(items: Iterable<T>): T[] => [...new Set(items)];

/** "Julia — invited reviewer" → "Julia": the name is the title up to its first ` — `. */
function displayName(stakeholder: ParsedConcept): string | null {
  const title = stakeholder.title ?? null;
  if (title === null) return null;
  return title.split(" — ")[0]?.trim() || null;
}

interface FeedbackFacts {
  id: string;
  from: string | null;
  route: string | null;
  url: string | null;
  resolution: string | null;
}

/** A batch name that is not taken: today's date, then `-2`, `-3`, … */
async function freeBatchName(root: string): Promise<string> {
  const base = todayIsoDate();
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    try {
      await fs.access(batchFile(root, name));
    } catch {
      return name;
    }
  }
}

/**
 * Stages candidate change entries from what closed since the last freeze:
 *
 * - one `new`/`done` candidate per task that reached Done, unless an existing
 *   entry already names that task — its routes from `pages.md` and the
 *   feedback it resolved, its requester from `genesis` → FEEDBACK → `from`,
 *   its links from that feedback's `url`;
 * - an `update` to `done` for each coming or exploring entry whose tasks are
 *   now all done — the roadmap item becoming the changelog line;
 * - a `new`/`exploring` candidate per task in Doing that no entry names.
 *
 * Todo rows are never proposed as `coming`: a ledger holds far more than a
 * stakeholder should be promised, so a coming entry is one a person adds.
 */
export async function draftChangelog(root: string): Promise<DraftResult> {
  const { recordRoot } = await requireCurrentRecord(root);
  const bundle = await scanBundle(root, { recordRoot });
  const freezes = await readFreezes(root).catch(() => []);
  const since = freezes.at(-1)?.tag ?? null;

  const ledger = bundle.concepts.find((concept) => concept.type === "Task Ledger");
  const tasks = ledger
    ? allEntries(parseTodos(ledger.body))
        .filter((entry) => entry.id !== null)
        .map((entry) => ({ entry, view: taskView(entry) }))
    : [];
  const isDone = (view: ReturnType<typeof taskView>, checked: boolean | null | undefined) =>
    view.status === "done" || checked === true;
  const doneNow = new Set(
    tasks.filter(({ entry, view }) => isDone(view, entry.checked)).map(({ view }) => view.id),
  );
  const doneBefore = new Set(
    since === null ? [] : ((await ledgerAt(root, since)) ?? []).map((task) => task.id),
  );

  const stakeholders = new Map<string, string>();
  const feedback = new Map<string, FeedbackFacts>();
  const existing: Array<ReturnType<typeof readChange>["change"]> = [];
  for (const concept of bundle.concepts) {
    if (concept.type === "Stakeholder" && concept.id) {
      const name = displayName(concept);
      if (name) stakeholders.set(concept.id, name);
    } else if (concept.type === "Feedback" && concept.id) {
      const route = asString(concept.frontmatter.route);
      feedback.set(concept.id, {
        id: concept.id,
        from: asString(concept.frontmatter.from),
        route: route ? normalizeRoute(route) : null,
        url: asString(concept.frontmatter.url),
        resolution: asString(concept.frontmatter.resolution),
      });
    } else if (concept.type === "Change") {
      existing.push(readChange(concept).change);
    }
  }

  const pages = bundle.concepts.find((concept) => concept.type === "Page Manifest");
  const pageRows = pages ? parsePageRows(pages.body).rows : [];

  const covered = new Set(existing.flatMap((change) => change.refs));

  const candidateFor = (taskId: string, title: string, status: ChangeStatus, reason: string) => {
    const entry = tasks.find(({ view }) => view.id === taskId);
    const genesisFeedback = /\bFEEDBACK-\d+\b/.exec(entry?.view.genesis ?? "")?.[0] ?? null;
    const resolved = [...feedback.values()].filter((item) => item.resolution === taskId);
    const behind = unique([
      ...(genesisFeedback && feedback.has(genesisFeedback) ? [genesisFeedback] : []),
      ...resolved.map((item) => item.id),
    ]).map((id) => feedback.get(id) as FeedbackFacts);

    const routes = unique([
      ...pageRows
        .filter((row) => row.refs.includes(taskId))
        .map((row) => normalizeRoute(row.route)),
      ...behind.flatMap((item) => (item.route ? [item.route] : [])),
    ]);
    // `from` is a stakeholder id on feedback filed by hand, and the name the
    // reviewer typed on feedback triaged from a review (DDR-141): read both.
    const nameOf = (from: string | null): string | null => {
      if (from === null) return null;
      return /^STAKEHOLDER-\d+$/.test(from) ? (stakeholders.get(from) ?? null) : from;
    };
    const requester = behind.map((item) => nameOf(item.from)).find((name) => name !== null) ?? null;
    const links = unique(behind.flatMap((item) => (item.url ? [item.url] : [])));

    const staged: StagedChange = {
      keep: false,
      action: "new",
      title,
      body: "",
      change_status: status,
      routes,
      requested_by: requester,
      links,
      refs: [taskId, ...behind.map((item) => item.id)],
      reason,
    };
    return staged;
  };

  const entries: StagedChange[] = [];
  const sinceWords = since === null ? "(no freeze yet)" : `since ${since}`;

  for (const { entry, view } of tasks) {
    if (!isDone(view, entry.checked) || doneBefore.has(view.id) || covered.has(view.id)) continue;
    entries.push(
      candidateFor(view.id, view.title, "done", `${view.id} reached Done ${sinceWords}`),
    );
  }

  for (const change of existing) {
    if (change.status !== "coming" && change.status !== "exploring") continue;
    const taskRefs = change.refs.filter((ref) => ref.startsWith("TASK-"));
    if (taskRefs.length === 0 || !taskRefs.every((ref) => doneNow.has(ref))) continue;
    entries.push({
      keep: false,
      action: "update",
      id: change.id,
      change_status: "done",
      reason: `every task behind ${change.id} is done (${taskRefs.join(", ")}) — it shipped in this version`,
    });
  }

  for (const { view } of tasks) {
    if (view.status !== "doing" || covered.has(view.id)) continue;
    entries.push(candidateFor(view.id, view.title, "exploring", `${view.id} is in Doing`));
  }

  const batch = await freeBatchName(root);
  const staged: ChangelogBatch = {
    kind: "forge-changelog-draft",
    createdAt: new Date().toISOString(),
    since,
    notice: DISCLOSURE_NOTICE,
    entries,
  };
  await fs.mkdir(changelogDir(root), { recursive: true });
  await writeNewFile(batchFile(root, batch), `${JSON.stringify(staged, null, 2)}\n`);
  return {
    batch,
    path: path.relative(root, batchFile(root, batch)),
    since,
    entries,
  };
}

export interface AppliedChange {
  id: string;
  action: "new" | "update";
  /** repo-relative */
  path: string;
}

export interface ApplyChangelogResult {
  written: AppliedChange[];
  /** candidates left unkept */
  skipped: number;
  /** worth saying, never a refusal: routes `pages.md` does not declare */
  notes: string[];
}

function readStringList(value: unknown, field: string, where: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new CliError(`${where}: \`${field}\` must be a list of strings`);
  }
  const items = (value as string[]).map((item) => item.trim()).filter((item) => item !== "");
  return items.length > 0 ? items : undefined;
}

/**
 * The frontmatter fields an entry sets. A list left empty is omitted rather
 * than written as `[]`, and a requester set to null or "" is removed — which
 * is how a creator takes a name off an entry before it crosses.
 */
function entryFields(staged: StagedChange, where: string): Record<string, unknown> {
  const requested = staged.requested_by;
  if (requested !== undefined && requested !== null && typeof requested !== "string") {
    throw new CliError(`${where}: \`requested_by\` must be a name or null`);
  }
  if (staged.audience !== undefined && !isAudience(String(staged.audience))) {
    throw new CliError(`${where}: \`audience\` must be owner or stakeholders`);
  }
  return {
    change_status: staged.change_status,
    routes: readStringList(staged.routes, "routes", where)?.map(normalizeRoute),
    requested_by: asString(requested) ?? undefined,
    links: readStringList(staged.links, "links", where),
    refs: readStringList(staged.refs, "refs", where),
    audience: staged.audience,
  };
}

/**
 * Writes the entries a person kept in `.forge/changelog/<batch>.json`, and
 * nothing else. Every file is built and checked before any is written, so a
 * batch with one bad entry writes none of them.
 */
export async function applyChangelog(root: string, batch: string): Promise<ApplyChangelogResult> {
  if (!BATCH_RE.test(batch)) {
    throw new CliError(
      `"${batch}" is not a batch name — use the name \`forge changelog draft\` printed`,
    );
  }
  let raw: string;
  try {
    raw = await fs.readFile(batchFile(root, batch), "utf8");
  } catch {
    throw new CliError(
      `no staged changelog at .forge/changelog/${batch}.json — run \`forge changelog draft\` first`,
    );
  }
  let parsed: ChangelogBatch;
  try {
    parsed = JSON.parse(raw) as ChangelogBatch;
  } catch (error) {
    throw new CliError(
      `.forge/changelog/${batch}.json is not valid JSON — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed.appliedAt) {
    throw new CliError(
      `.forge/changelog/${batch}.json was applied at ${parsed.appliedAt} (${(parsed.applied ?? []).join(", ") || "nothing kept"}) — draft a new batch rather than applying this one twice`,
    );
  }
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const kept = entries.filter((entry) => entry?.keep === true);
  if (kept.length === 0) return { written: [], skipped: entries.length, notes: [] };

  const { recordRoot } = await requireCurrentRecord(root);
  const bundle = await scanBundle(root, { recordRoot });
  const changes = new Map(
    bundle.concepts
      .filter((concept) => concept.type === "Change" && concept.id)
      .map((concept) => [concept.id as string, concept]),
  );
  const pages = bundle.concepts.find((concept) => concept.type === "Page Manifest");
  const declared = pages
    ? new Set(parsePageRows(pages.body).rows.map((row) => normalizeRoute(row.route)))
    : null;

  const allocated: string[] = [];
  const planned: Array<AppliedChange & { contents: string; isNew: boolean }> = [];
  for (const staged of kept) {
    const where = `entry ${entries.indexOf(staged) + 1}`;
    if (!isChangeStatus(String(staged.change_status))) {
      throw new CliError(
        `${where}: \`change_status\` must be one of ${CHANGE_STATUSES.join(", ")}`,
      );
    }
    const fields = entryFields(staged, where);

    if (staged.action === "update") {
      const target = staged.id ? changes.get(staged.id) : undefined;
      if (!target) {
        throw new CliError(`${where}: no change entry ${staged.id ?? "(no id)"} to update`);
      }
      // Only the fields the batch names move; everything else stays as written.
      // A requester the batch sets to null or "" is removed, which is how a name
      // comes off an entry before it crosses.
      const updates: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined) updates[key] = value;
      }
      if (staged.requested_by !== undefined && fields.requested_by === undefined) {
        updates.requested_by = undefined;
      }
      const title = asString(staged.title);
      if (title) updates.title = title;
      let contents = setFrontmatterFields(target.raw, updates);
      const body = asString(staged.body);
      if (body) contents = setBody(contents, `${body}\n`);
      planned.push({
        id: target.id as string,
        action: "update",
        path: path.join(recordRoot, target.relPath),
        contents,
        isNew: false,
      });
      continue;
    }

    if (staged.action !== "new") {
      throw new CliError(`${where}: \`action\` must be new or update`);
    }
    const title = asString(staged.title);
    if (!title) throw new CliError(`${where}: a new entry needs a \`title\``);
    const id = nextId([...changes.keys(), ...allocated], "CHANGE");
    allocated.push(id);
    const body = asString(staged.body);
    const contents = withFrontmatter(
      { type: "Change", id, title, date: todayIsoDate(), ...fields },
      body ? `${body}\n` : "",
    );
    planned.push({
      id,
      action: "new",
      path: path.join(recordRoot, "changes", `${id}.md`),
      contents,
      isNew: true,
    });
  }

  // Every entry is checked as the doctor would check it, before anything lands.
  const problems: string[] = [];
  const notes: string[] = [];
  for (const plan of planned) {
    const relPath = path.posix.join("changes", path.basename(plan.path));
    const concept = parseConcept(relPath, plan.contents);
    for (const problem of concept.problems) problems.push(`${plan.id}: ${problem.message}`);
    const { change, problems: fieldProblems } = readChange(concept);
    for (const problem of fieldProblems) problems.push(`${plan.id}: ${problem.message}`);
    if (declared) {
      for (const route of change.routes) {
        if (!declared.has(normalizeRoute(route))) {
          notes.push(`${plan.id}: \`${route}\` is not in pages.md — add a row if it is a page`);
        }
      }
    }
  }
  if (problems.length > 0) {
    throw new CliError(`nothing written — fix the batch first:\n  ${problems.join("\n  ")}`);
  }

  await fs.mkdir(path.join(root, recordRoot, "changes"), { recursive: true });
  for (const plan of planned) {
    const file = path.join(root, plan.path);
    if (plan.isNew) await writeNewFile(file, plan.contents);
    else await writeFileAtomic(file, plan.contents);
  }
  await writeBundleIndex(root);

  const applied: ChangelogBatch = {
    ...parsed,
    appliedAt: new Date().toISOString(),
    applied: planned.map((plan) => plan.id),
  };
  await writeFileAtomic(batchFile(root, batch), `${JSON.stringify(applied, null, 2)}\n`);

  return {
    written: planned.map(({ id, action, path: relPath }) => ({ id, action, path: relPath })),
    skipped: entries.length - kept.length,
    notes,
  };
}
