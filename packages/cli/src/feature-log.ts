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
  parseTodos,
  taskView,
  withFrontmatter,
} from "@forgedesign/format";
import { bundleRootOf, writeBundleIndex } from "./bundle-index.js";
import type { FreezeRecord } from "./freezes.js";
import { git } from "./git.js";

export interface ClosedTask {
  id: string;
  title: string;
}

export interface FreezeFeatures {
  tag: string;
  date: string;
  freezeId: string;
  closed: ClosedTask[];
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
 * Rewrites `design/feature-log.md` from the freeze registry: one section per
 * freeze, newest first, listing the tasks that reached Done between it and the
 * one before.
 *
 * A flat list per section, per the creator's 2026-07-24 decision — there is no
 * `view:` field to group by, and inventing one to serve a generator is the rot
 * spec §1 principle 3 warns about.
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
    sections.push({
      tag: freeze.tag,
      date: freeze.date,
      freezeId: formatId("FREEZE", index + 1),
      closed: current.filter((task) => !previousIds.has(task.id)),
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
