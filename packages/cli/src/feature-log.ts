// Generating the feature log at freeze time (T-238, spec/format.md §5).
//
// "What closed since the previous freeze" has no field to read: a task carries
// `opened` and a `status`, never a closed date, and inventing one would be a
// format change to serve one generator (spec §1 principle 3). It does not need
// one — freezes are Git tags, so the question is literally a diff between two
// of them. This reads the task ledger as it stood at each freeze and compares
// consecutive pairs, which is exact, needs no new field, and cannot drift the
// way a hand-maintained date would.
//
// The whole file is regenerated from every freeze each time rather than having
// a section appended. A derived file that accumulates by side effect drifts the
// moment one run is interrupted; one that is reproducible from the tags is the
// same file whenever you rebuild it, which is what makes doctor's "regenerate
// and compare" check meaningful.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  allEntries,
  buildDerivedMarker,
  formatId,
  parseConcept,
  parsePageRows,
  parseTodos,
  scanBundle,
  taskView,
  withFrontmatter,
} from "@forgedesign/format";
import { bundleRootOf, writeBundleIndex } from "./bundle-index.js";
import type { FreezeRecord } from "./freezes.js";
import { git } from "./git.js";
import { compareScreens, normalizeRoute, type ScreenComparison } from "./routes.js";

export interface ClosedTask {
  id: string;
  title: string;
}

/** Feedback stamped `addressed_in` this freeze's tag, with the route it was left on. */
export interface AddressedFeedback {
  id: string;
  title: string;
  route: string | null;
}

export interface AcceptedDecision {
  id: string;
  title: string;
}

/** What the page manifest declares about a route (DDR-130): a title, and what touches it. */
export interface PageIntent {
  title: string;
  refs: string[];
}

export interface FreezeFeatures {
  tag: string;
  date: string;
  freezeId: string;
  closed: ClosedTask[];
  /** which built routes changed since the freeze before (TASK-461) */
  screens: ScreenComparison;
  addressed: AddressedFeedback[];
  /** decisions that reached `accepted` between the freeze before and this one */
  accepted: AcceptedDecision[];
  /** the page manifest as it stood at this tag, by normalised route; empty when there was none */
  pages: Record<string, PageIntent>;
}

export interface FeatureLogResult {
  /** repo-relative path written, or null when there was nothing to write */
  path: string | null;
  /** newest freeze first, matching the file */
  freezes: FreezeFeatures[];
  warnings: string[];
}

/**
 * Every ledger path a record might have had, newest convention first.
 *
 * This list survives DDR-095 and is not a v0.1 fallback. It is read against
 * *older git refs*: a record that has been through `forge upgrade` kept its
 * ledger somewhere else at the tags being compared, and the `TASK-###` ids
 * survive the migration, so the comparison still holds. Dropping the old paths
 * would empty the feature log of every freeze taken before a project migrated —
 * the opposite of what refusing to *serve* v0.1 is for.
 */
const LEDGER_PATHS = [path.join("design", "todos.md"), "Todos.md", path.join("todo", "todo.md")];

function doneTasks(ledgerText: string, isConcept: boolean): ClosedTask[] {
  const body = isConcept ? parseConcept("todos.md", ledgerText).body : ledgerText;
  return allEntries(parseTodos(body))
    .filter((entry) => entry.id !== null)
    .map((entry) => ({ entry, view: taskView(entry) }))
    .filter(({ entry, view }) => view.status === "done" || entry.checked === true)
    .map(({ entry, view }) => ({ id: entry.id as string, title: view.title }));
}

/**
 * The done-task set as it stood at `ref`, or null when the repo had no ledger
 * there. Tries each path convention because a record that has been through
 * `forge upgrade` had its ledger somewhere else in older tags — and the
 * `TASK-###` ids survive that migration, so the comparison still holds.
 */
async function ledgerAt(root: string, ref: string): Promise<ClosedTask[] | null> {
  for (const relPath of LEDGER_PATHS) {
    try {
      const text = await git(root, ["show", `${ref}:${relPath}`]);
      return doneTasks(text, relPath.startsWith("design"));
    } catch {
      // not at this path in that revision — try the next convention
    }
  }
  return null;
}

/**
 * The page manifest as it stood at a tag, keyed by normalised route — or
 * nothing, for a freeze cut before the record had one (DDR-130).
 *
 * Read at the tag like the ledger and the decisions, not from the working
 * tree: a page renamed after a freeze must not rewrite the intent that freeze
 * was built to. A route declared twice keeps its first row here; doctor is
 * what reports the second, and a generator does not guess.
 */
async function pagesAt(
  root: string,
  ref: string,
  recordRoot: string,
): Promise<Record<string, PageIntent>> {
  let text: string;
  try {
    text = await git(root, ["show", `${ref}:${path.posix.join(recordRoot, "pages.md")}`]);
  } catch {
    return {};
  }
  const pages: Record<string, PageIntent> = {};
  for (const row of parsePageRows(parseConcept("pages.md", text).body).rows) {
    pages[normalizeRoute(row.route)] ??= { title: row.title, refs: row.refs };
  }
  return pages;
}

/** Every path a record's decisions may have sat at in older tags, newest convention first. */
const DECISION_DIRS = (recordRoot: string) => [path.join(recordRoot, "decisions"), "decisions"];

const asString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** `git show ref:path` as a parsed decision, or null when the file is not there. */
export async function decisionAt(
  root: string,
  ref: string,
  relPath: string,
): Promise<{ id: string; title: string; accepted: boolean } | null> {
  try {
    const text = await git(root, ["show", `${ref}:${relPath}`]);
    const concept = parseConcept(path.basename(relPath), text);
    if (!concept.id || concept.id === "DDR-000") return null;
    return {
      id: concept.id,
      title: concept.title ?? concept.id,
      accepted: concept.domainStatus?.value === "accepted",
    };
  } catch {
    return null;
  }
}

/**
 * Decisions that reached `accepted` between two tags, read the way "what
 * closed" is: from the files as they stood at each tag. A decision that was
 * already accepted at the earlier tag and merely gained `amended_by` since is
 * not listed — it was not accepted in this release, it was cited.
 */
async function decisionsAcceptedBetween(
  root: string,
  recordRoot: string,
  previousTag: string | null,
  tag: string,
): Promise<AcceptedDecision[]> {
  const dirs = DECISION_DIRS(recordRoot);
  let listing: string;
  try {
    listing = previousTag
      ? await git(root, ["diff", "--name-only", previousTag, tag, "--", ...dirs])
      : await git(root, ["ls-tree", "-r", "--name-only", tag, "--", ...dirs]);
  } catch {
    return [];
  }
  const files = listing
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.endsWith(".md"))
    .sort();

  const accepted: AcceptedDecision[] = [];
  for (const file of files) {
    const now = await decisionAt(root, tag, file);
    if (!now?.accepted) continue;
    const before = previousTag ? await decisionAt(root, previousTag, file) : null;
    if (before?.accepted) continue;
    accepted.push({ id: now.id, title: now.title });
  }
  return accepted;
}

/**
 * Feedback stamped `addressed_in`, grouped by the tag that addressed it. Read
 * from the working tree rather than the tags: the stamp is written by the
 * resolution trail at freeze time and never moves, and reading it live is what
 * lets a freeze's own section carry the feedback it just addressed.
 */
async function addressedByTag(
  root: string,
  recordRoot: string,
): Promise<Map<string, AddressedFeedback[]>> {
  const grouped = new Map<string, AddressedFeedback[]>();
  const bundle = await scanBundle(root, { recordRoot });
  const feedback = bundle.concepts
    .filter((concept) => concept.type === "Feedback" && concept.id)
    .sort((a, b) => (a.id as string).localeCompare(b.id as string));
  for (const concept of feedback) {
    const tag = asString(concept.frontmatter.addressed_in);
    if (!tag) continue;
    const route = asString(concept.frontmatter.route);
    const list = grouped.get(tag) ?? [];
    list.push({
      id: concept.id as string,
      title: concept.title ?? (concept.id as string),
      route: route ? normalizeRoute(route) : null,
    });
    grouped.set(tag, list);
  }
  return grouped;
}

/**
 * The `### Screens` lines for one freeze: what changed, what the manifest says
 * the screen is and what touches it (DDR-130), and the feedback it addressed.
 */
function screenLines(section: FreezeFeatures): string[] {
  const addressedOn = (route: string) =>
    section.addressed.filter((item) => item.route === route).map((item) => item.id);
  const withFeedback = (route: string, status: string) => {
    // Declared intent sits beside the derived status, never instead of it: a
    // route with no row reads exactly as it did before the manifest existed.
    const page = section.pages[route];
    const intent = page
      ? ` — ${page.title}${page.refs.length > 0 ? ` (${page.refs.join(", ")})` : ""}`
      : "";
    const ids = addressedOn(route);
    return `- \`${route}\` ${status}${intent}${ids.length > 0 ? ` — addresses ${ids.join(", ")}` : ""}`;
  };
  const routed = new Set(
    section.addressed.flatMap((item) => (item.route === null ? [] : [item.route])),
  );

  const { screens } = section;
  const lines: string[] = [];
  switch (screens.kind) {
    case "unrecorded":
      lines.push(
        "Route hashes were not recorded for this freeze, so its screens cannot be compared.",
      );
      break;
    case "baseline-unrecorded":
      lines.push(
        `${screens.previousTag} recorded no route hashes, so this freeze's screens cannot be compared with it. Routes: ${screens.routes.map((route) => `\`${route}\``).join(", ")}.`,
      );
      break;
    case "first":
      lines.push("First freeze — every screen is new.");
      lines.push(...screens.screens.map((screen) => withFeedback(screen.route, "new")));
      break;
    case "compared": {
      const moved = screens.screens.filter((screen) => screen.status !== "unchanged");
      if (moved.length === 0) {
        lines.push(`No screen changed since ${screens.previousTag}.`);
      } else {
        lines.push(...moved.map((screen) => withFeedback(screen.route, screen.status)));
      }
      // Feedback addressed on a screen whose hash did not move still belongs
      // to that screen — say so rather than hide it under "unchanged".
      for (const screen of screens.screens) {
        if (screen.status === "unchanged" && routed.has(screen.route)) {
          lines.push(withFeedback(screen.route, "unchanged"));
        }
      }
      break;
    }
  }

  // Feedback with no route, or on a route this freeze has no screen for, is
  // still addressed here — it just has no screen line to sit under.
  const unrouted = section.addressed.filter(
    (item) => item.route === null || !screensHave(screens, item.route),
  );
  if (unrouted.length > 0) {
    lines.push(`- also addresses ${unrouted.map((item) => item.id).join(", ")}`);
  }
  return lines;
}

function screensHave(screens: ScreenComparison, route: string): boolean {
  if (screens.kind === "first" || screens.kind === "compared") {
    return screens.screens.some((screen) => screen.route === route);
  }
  return false;
}

/**
 * Rewrites `design/feature-log.md` from the freeze registry: one section per
 * freeze, newest first, listing the tasks that reached Done between it and the
 * one before, which screens changed, and which decisions were accepted.
 *
 * The tasks stay a flat list, per the creator's 2026-07-24 decision — there is
 * no `view:` field to group by, and inventing one to serve a generator is the
 * rot spec §1 principle 3 warns about. Which *screens* changed needs no field
 * either: `forge freeze` records a content hash per built route, and two
 * freezes' hashes answer it (TASK-461, DDR-121). What a screen is *called* and
 * what touches it is intent, not derivation — a page manifest declares it when
 * the record has one, and each screen line carries it beside the derived
 * status (DDR-130).
 */
export async function generateFeatureLog(
  root: string,
  freezes: readonly FreezeRecord[],
): Promise<FeatureLogResult> {
  const warnings: string[] = [];
  const recordRoot = await bundleRootOf(root);
  // A record that is not current does not get a feature log — DDR-095, and this
  // is where that rule was already true before it was a decision.
  if (recordRoot === null || freezes.length === 0) {
    return { path: null, freezes: [], warnings };
  }

  const addressed = await addressedByTag(root, recordRoot);
  const sections: FreezeFeatures[] = [];
  let previous: ClosedTask[] | null = null;
  let current: ClosedTask[];

  for (const [index, freeze] of freezes.entries()) {
    const at = await ledgerAt(root, freeze.tag);
    if (at === null) {
      warnings.push(`feature log: no task ledger at ${freeze.tag} — its section is empty`);
    }
    current = at ?? previous ?? [];
    const previousIds = new Set((previous ?? []).map((task: ClosedTask) => task.id));
    const previousFreeze = freezes[index - 1] ?? null;
    sections.push({
      tag: freeze.tag,
      date: freeze.date,
      freezeId: formatId("FREEZE", index + 1),
      closed: current.filter((task) => !previousIds.has(task.id)),
      screens: compareScreens(freeze, previousFreeze),
      addressed: addressed.get(freeze.tag) ?? [],
      accepted: await decisionsAcceptedBetween(
        root,
        recordRoot,
        previousFreeze?.tag ?? null,
        freeze.tag,
      ),
      pages: await pagesAt(root, freeze.tag, recordRoot),
    });
    previous = current;
  }

  sections.reverse(); // newest first, the way every other history surface reads
  const latest = sections[0];

  const body = [
    // The frontmatter `generated` key is what makes the file derived (spec §3);
    // this line is for a human reading the raw file, which is most of them.
    buildDerivedMarker("forge freeze", latest?.freezeId ?? "FREEZE-001"),
    "",
    ...sections.flatMap((section) => [
      `## ${section.tag} — ${section.date}`,
      "",
      ...(section.closed.length === 0
        ? ["Nothing closed since the previous freeze."]
        : section.closed.map((task) => `- ${task.id} ${task.title}`)),
      "",
      "### Screens",
      "",
      ...screenLines(section),
      "",
      ...(section.accepted.length === 0
        ? []
        : [
            "### Decisions accepted",
            "",
            ...section.accepted.map((decision) => `- ${decision.id} ${decision.title}`),
            "",
          ]),
    ]),
  ].join("\n");

  const relPath = path.join(recordRoot, "feature-log.md");
  await fs.writeFile(
    path.join(root, relPath),
    withFrontmatter(
      {
        type: "Feature Log",
        title: "Feature log",
        freeze: latest?.freezeId,
        generated: { by: "forge-cli/0.1.0", at: new Date().toISOString() },
      },
      body,
    ),
    "utf8",
  );

  // A new concept changes the bundle listing, so the writer that adds one keeps
  // the index true (T-300) — the same rule `ddr apply` and triage follow.
  await writeBundleIndex(root);

  return { path: relPath, freezes: sections, warnings };
}
