// `forge upgrade` — migrates a v1 repo layout (todo/todo.md, context/brief.md,
// artifacts/glossary.md) to the v0.1 Design Record file set (spec/format.md
// §7). Additive and idempotent: an already-migrated file is never
// overwritten, and no v1 source file is ever deleted — Git is the archive.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  allEntries,
  buildForgeManifest,
  type ForgeManifest,
  isSupportedFormatVersion,
  type LedgerDocument,
  type LedgerEntry,
  type MigrationPlan,
  parseForgeJson,
  parseLedger,
  pathState,
  planMigrationToV02,
  scanRecord,
  serializeForgeJson,
  serializeTodos,
  TASK_SECTIONS,
  type TaskSection,
  V01_FORMAT_VERSION,
  type V01Sources,
  V02_FORMAT_VERSION,
} from "@forgedesign/format";
import { parseTodo, phaseHeading, type TodoDocument } from "./todo.js";

export interface UpgradeResult {
  written: string[];
  skipped: string[];
  /** Targets a case-variant file occupies, which upgrade refuses to overwrite. */
  blocked: Array<{ target: string; variant: string }>;
  migratedTaskCount: number;
  /** prose between tasks that the four-section ledger cannot hold — reported, not hidden */
  droppedBlocks: number;
  /** existing files edited in place so their `T-###` references follow the rename */
  rewritten: string[];
  /** v1 sources now represented by a v0.1 file — reported, deleted only with --prune */
  superseded: string[];
  pruned: string[];
}

export interface UpgradeOptions {
  /** delete the superseded v1 sources after a successful migration */
  prune?: boolean;
}

/**
 * The v1 source each v0.1 file replaces. Migrating leaves both on disk, which
 * is right for a dry run and wrong as a resting state — two homes for one fact
 * is what spec §1 principle 2 forbids, and T-256 showed the cost is real (the
 * handoff generator read the stale copy).
 */
const V1_SOURCES: ReadonlyArray<{ source: string; target: string }> = [
  { source: path.join("todo", "todo.md"), target: "Todos.md" },
  { source: path.join("context", "brief.md"), target: "Brief.md" },
  { source: path.join("artifacts", "glossary.md"), target: "Glossary.md" },
];

async function readIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const SECTION_MAP: Record<string, TaskSection> = {
  Backlog: "Todo",
  "In progress": "Doing",
  Done: "Done",
  Deferred: "Deferred",
};

function mapSection(heading: string): TaskSection {
  return SECTION_MAP[heading] ?? "Todo";
}

/**
 * Where a v1 task lands. The section heading is the intended signal, but a
 * checked box is the one an author ticks at the moment the work finishes, in
 * place — moving the entry to `## Done` is a second, separate act that repos
 * skip. When the two disagree, the box wins, and only in the direction that
 * cannot lose work: `[x]` is done wherever it sits, while an unchecked entry
 * keeps whatever its section says. Reading the section alone emitted rows whose
 * checkbox and `status:` contradicted each other, which is how the wrongness
 * announced itself.
 */
function targetSection(heading: string, checked: boolean): TaskSection {
  return checked ? "Done" : mapSection(heading);
}

function buildIdMap(doc: TodoDocument): Map<string, string> {
  const map = new Map<string, string>();
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.kind === "task" && block.task.id) {
        map.set(block.task.id, `TASK-${block.task.id.slice(2)}`);
      }
    }
  }
  return map;
}

/** Rewrites every `T-###` token (the only id shape that changes prefix) via `idMap`. */
function rewriteIds(text: string, idMap: ReadonlyMap<string, string>): string {
  return text.replace(/\bT-\d+\b/g, (match) => idMap.get(match) ?? match);
}

function buildMigratedEntry(lines: string[]): LedgerEntry {
  const doc = parseLedger(`${lines.join("\n")}\n`, { checkbox: true });
  const entry = allEntries(doc)[0];
  if (!entry) throw new Error(`failed to rebuild a migrated task entry from: ${lines[0]}`);
  return entry;
}

export interface MigratedTodos {
  doc: LedgerDocument;
  taskCount: number;
  /** prose and headings between tasks, which the four-section ledger has no place for */
  droppedBlocks: number;
}

/**
 * Builds the v0.1 Todos.md document from a parsed v1 todo.md.
 *
 * The regroup by status is what makes phase headings unrepresentable inline:
 * one `### Phase 47` heading's tasks scatter across all four sections, so a
 * heading kept in place would sit above tasks it no longer covers. The phase
 * moves onto the row instead (DDR-068) — which is also the only form a
 * consumer can group by. Prose written *under* a heading has no such home and
 * is counted rather than silently dropped.
 */
export function migrateTodos(oldDoc: TodoDocument): MigratedTodos {
  const idMap = buildIdMap(oldDoc);
  const doc: LedgerDocument = {
    preambleBlocks: [],
    sections: TASK_SECTIONS.map((heading) => ({
      heading,
      headingLine: `## ${heading}`,
      blocks: [],
    })),
    trailingNewline: true,
  };

  let taskCount = 0;
  let droppedBlocks = 0;
  for (const section of oldDoc.sections) {
    let phase: string | null = null;
    for (const block of section.blocks) {
      if (block.kind === "raw") {
        for (const line of block.lines) {
          const heading = phaseHeading(line);
          if (heading) phase = heading;
          else if (line.trim() !== "") droppedBlocks++;
        }
        continue;
      }
      if (!block.task.id) continue;
      const task = block.task;
      const targetHeading = targetSection(section.heading, task.checked);
      const target = doc.sections.find((s) => s.heading === targetHeading)!;
      const newId = idMap.get(task.id!)!;
      const newStatus = targetHeading.toLowerCase();
      const bulletLine = rewriteIds(
        `- [${task.checked ? "x" : " "}] ${newId} ${task.title}`.trimEnd(),
        idMap,
      );
      const statusLine = `  status: ${newStatus}`;
      const phaseLine = phase === null ? [] : [`  phase: ${rewriteIds(phase, idMap)}`];
      const rest = task.lines.slice(1).map((line) => rewriteIds(line, idMap));
      const entry = buildMigratedEntry([bulletLine, statusLine, ...phaseLine, ...rest]);
      target.blocks.push({ kind: "entry", entry });
      taskCount++;
    }
  }

  return { doc, taskCount, droppedBlocks };
}

async function mergeForgeJson(text: string | null): Promise<string> {
  const manifest: ForgeManifest = text ? parseForgeJson(text) : buildForgeManifest();
  // Pinned to v0.1, not whatever init writes: this migration produces the v0.1
  // root-file layout, so stamping whatever init currently writes would claim a
  // format the files on disk are not in. `--to 0.2` is the next hop.
  manifest.formatVersion = V01_FORMAT_VERSION;
  return serializeForgeJson(manifest);
}

/**
 * Rewrites `T-###` citations inside `decisions/*.md` to the ids the ledger
 * migration assigned. Only files that actually change are written, so a rerun
 * touches nothing — and an id the ledger never declared is left alone rather
 * than guessed at, since a reference to a task that was never in `todo.md` is
 * a dangling reference either way and inventing a `TASK-` prefix for it would
 * only make it look resolvable.
 */
async function rewriteDecisionIds(
  root: string,
  idMap: ReadonlyMap<string, string>,
): Promise<string[]> {
  if (idMap.size === 0) return [];
  let filenames: string[];
  try {
    filenames = await fs.readdir(path.join(root, "decisions"));
  } catch {
    return [];
  }

  const rewritten: string[] = [];
  for (const filename of filenames.sort()) {
    if (!filename.endsWith(".md")) continue;
    const relPath = path.join("decisions", filename);
    const text = await readIfExists(path.join(root, relPath));
    if (text === null) continue;
    const updated = rewriteIds(text, idMap);
    if (updated === text) continue;
    await fs.writeFile(path.join(root, relPath), updated, "utf8");
    rewritten.push(relPath);
  }
  return rewritten;
}

/**
 * Migrates whatever v1 sources exist under `root` to the v0.1 file set.
 * Safe to re-run: an already-migrated target file is left untouched, and no
 * v1 source is deleted unless `--prune` asks for it (T-259).
 */
export async function upgradeRecord(
  root: string,
  options: UpgradeOptions = {},
): Promise<UpgradeResult> {
  const written: string[] = [];
  const skipped: string[] = [];
  const blocked: UpgradeResult["blocked"] = [];
  let migratedTaskCount = 0;
  let droppedBlocks = 0;

  const todoText = await readIfExists(path.join(root, "todo", "todo.md"));
  const oldTodoDoc = todoText !== null ? parseTodo(todoText) : null;
  // used to rewrite T-### mentions in Brief.md/Glossary.md prose, not just Todos.md
  const idMap = oldTodoDoc ? buildIdMap(oldTodoDoc) : new Map<string, string>();

  /** One migration: write `text` to `name`, unless it exists or is blocked. */
  async function migrate(name: string, write: () => Promise<void>): Promise<boolean> {
    const state = await pathState(path.join(root, name));
    if (state.kind === "present") {
      skipped.push(name);
      return false;
    }
    if (state.kind === "collision") {
      blocked.push({ target: name, variant: state.found });
      return false;
    }
    await write();
    written.push(name);
    return true;
  }

  if (oldTodoDoc) {
    const { doc, taskCount, droppedBlocks: dropped } = migrateTodos(oldTodoDoc);
    droppedBlocks = dropped;
    const wrote = await migrate("Todos.md", () =>
      fs.writeFile(path.join(root, "Todos.md"), serializeTodos(doc), "utf8"),
    );
    if (wrote) migratedTaskCount = taskCount;
  }

  const briefText = await readIfExists(path.join(root, "context", "brief.md"));
  if (briefText !== null) {
    await migrate("Brief.md", () =>
      fs.writeFile(path.join(root, "Brief.md"), rewriteIds(briefText, idMap), "utf8"),
    );
  }

  const glossaryText = await readIfExists(path.join(root, "artifacts", "glossary.md"));
  if (glossaryText !== null) {
    await migrate("Glossary.md", () =>
      fs.writeFile(path.join(root, "Glossary.md"), rewriteIds(glossaryText, idMap), "utf8"),
    );
  }

  // Decisions do not move in this leg, so nothing above would touch them — and
  // a decision that cites `T-042` still says so after the ledger has renamed
  // that task to `TASK-042`. Every one of those citations is then a reference
  // to nothing, which is precisely what doctor rule 5 exists to catch, so a
  // migration that leaves them behind hands the user a record it has just
  // invalidated. They are rewritten in place: the alternative is a record whose
  // decisions all point at ids that no longer exist.
  const rewritten = await rewriteDecisionIds(root, idMap);

  // Only touch forge.json when there's an existing project to upgrade — either
  // it already exists, or something else here just got migrated. A directory
  // with nothing forge-related at all is not this command's concern (that's
  // `forge init`'s job); upgrade must not fabricate a project from thin air.
  const forgeJsonPath = path.join(root, "forge.json");
  const forgeJsonText = await readIfExists(forgeJsonPath);
  if (forgeJsonText !== null || written.length > 0) {
    const currentVersion = forgeJsonText
      ? (parseForgeJson(forgeJsonText).formatVersion ?? undefined)
      : undefined;
    // Any version this tooling understands is already at or past what this
    // migration produces — stamping v0.1 over a v0.2 manifest would downgrade
    // a migrated record to a format its files are no longer in.
    if (isSupportedFormatVersion(currentVersion)) {
      skipped.push("forge.json");
    } else {
      await fs.writeFile(forgeJsonPath, await mergeForgeJson(forgeJsonText), "utf8");
      written.push("forge.json");
    }
  }

  // A v1 source is superseded once its v0.1 file is on disk — whether this run
  // wrote it or an earlier one did, so the documented review-then-prune flow
  // isn't a no-op on exactly the run that asks to prune. Reviewing the migration
  // first is what makes this safe: a hand-written Brief.md would also count as
  // migrated here, which is why nothing is removed without being listed first.
  const onDisk = new Set([...written, ...skipped]);
  const superseded: string[] = [];
  for (const { source, target } of V1_SOURCES) {
    if (!onDisk.has(target)) continue;
    if ((await pathState(path.join(root, source))).kind !== "present") continue;
    superseded.push(source);
  }

  const pruned: string[] = [];
  if (options.prune) {
    for (const source of superseded) {
      await fs.rm(path.join(root, source));
      pruned.push(source);
      // Tidy the v1 folder when nothing else lives in it; rmdir refuses a
      // non-empty directory, which is exactly the behaviour wanted here.
      await fs.rmdir(path.join(root, path.dirname(source))).catch(() => {});
    }
  }

  return {
    written,
    skipped,
    blocked,
    migratedTaskCount,
    droppedBlocks,
    rewritten,
    superseded,
    pruned,
  };
}

/** Saved scenarios in the pre-bundle `scenarios/` folder (DDR-063 migration). */
async function readLegacyScenarios(root: string): Promise<Array<{ slug: string; text: string }>> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.join(root, "scenarios"));
  } catch {
    return [];
  }
  const scenarios: Array<{ slug: string; text: string }> = [];
  for (const name of entries.sort()) {
    if (!name.endsWith(".md")) continue;
    const text = await readIfExists(path.join(root, "scenarios", name));
    if (text !== null) scenarios.push({ slug: name.slice(0, -".md".length), text });
  }
  return scenarios;
}

// --- v0.1 → v0.2 (the OKF bundle, spec §8) ---------------------------------

export interface UpgradeV02Result {
  written: string[];
  skipped: string[];
  /** v0.1 sources now represented under `design/` — reported, deleted only with --prune */
  superseded: string[];
  pruned: string[];
  warnings: string[];
}

export interface UpgradeV02Options {
  /** delete the superseded v0.1 sources after a successful migration */
  prune?: boolean;
}

/**
 * Migrates a v0.1 record into the v0.2 `design/` bundle.
 *
 * Additive by default and safe to re-run: an already-written target is left
 * alone, and no v0.1 source is removed unless `--prune` asks for it. The
 * creator's 2026-07-24 decision (T-259) is the shape here — report loudly, then
 * delete on request, so Git stays the archive and nothing disappears unasked.
 */
export async function upgradeRecordToV02(
  root: string,
  options: UpgradeV02Options = {},
): Promise<UpgradeV02Result> {
  const record = await scanRecord(root);
  const sources: V01Sources = {
    brief: record.files["Brief.md"]?.text,
    todos: record.files["Todos.md"]?.text,
    glossary: record.files["Glossary.md"]?.text,
    openQuestions: record.files["OpenQuestions.md"]?.text,
    feedbacks: record.files["Feedbacks.md"]?.text,
    stakeholders: record.files["Stakeholders.md"]?.text,
    userStories: record.files["UserStories.md"]?.text,
    userRoles: record.files["UserRoles.md"]?.text,
    dataModel: record.files["DataModel.md"]?.text,
    processFlows: record.files["ProcessFlows.md"]?.text,
    calendar: record.files["Calendar.md"]?.text,
    design: record.files["Design.md"]?.text,
    components: record.files["Components.md"]?.text,
    featureLog: record.files["FeatureLog.md"]?.text,
    decisions: record.decisions.map(({ filename, text }) => ({ filename, text })),
    scenarios: await readLegacyScenarios(root),
  };

  const plan: MigrationPlan = planMigrationToV02(sources);
  const written: string[] = [];
  const skipped: string[] = [];

  for (const file of plan.files) {
    const abs = path.join(root, file.relPath);
    const state = await pathState(abs);
    if (state.kind !== "absent") {
      skipped.push(file.relPath);
      continue;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.text, "utf8");
    written.push(file.relPath);
  }

  if (written.length > 0 || skipped.length > 0) {
    const forgeJsonPath = path.join(root, "forge.json");
    const existing = await readIfExists(forgeJsonPath);
    const manifest: ForgeManifest = existing ? parseForgeJson(existing) : buildForgeManifest();
    if (manifest.formatVersion !== V02_FORMAT_VERSION || manifest.recordRoot !== "design") {
      manifest.formatVersion = V02_FORMAT_VERSION;
      manifest.recordRoot = "design";
      await fs.writeFile(forgeJsonPath, serializeForgeJson(manifest), "utf8");
      written.push("forge.json");
    }
  }

  // A v0.1 source is superseded once every file derived from it is on disk —
  // whether this run wrote it or a previous one did. Keying off "written"
  // alone would make `--prune` a no-op on exactly the run the creator's
  // review-then-prune flow calls for (T-259).
  const onDisk = new Set([...written, ...skipped]);
  const derivedFrom = new Map<string, string[]>();
  for (const file of plan.files) {
    derivedFrom.set(file.source, [...(derivedFrom.get(file.source) ?? []), file.relPath]);
  }
  const fullyMigrated = (source: string): boolean => {
    const derived =
      source === "decisions/"
        ? plan.files.filter((file) => file.source.startsWith("decisions/")).map((f) => f.relPath)
        : (derivedFrom.get(source) ?? []);
    return derived.length > 0 && derived.every((relPath) => onDisk.has(relPath));
  };
  const superseded = plan.supersededSources.filter(fullyMigrated);

  const pruned: string[] = [];
  if (options.prune) {
    for (const source of superseded) {
      if (source === "decisions/") {
        // The old folder is a different path from design/decisions/, so it is a
        // second home for every decision until its migrated files are removed.
        for (const decision of record.decisions) {
          const abs = path.join(root, decision.relPath);
          if ((await pathState(abs)).kind !== "present") continue;
          await fs.rm(abs);
          pruned.push(decision.relPath);
        }
        await fs.rmdir(path.join(root, "decisions")).catch(() => {});
        continue;
      }
      const abs = path.join(root, source);
      if ((await pathState(abs)).kind !== "present") continue;
      await fs.rm(abs);
      pruned.push(source);
    }
  }

  return { written, skipped, superseded, pruned, warnings: plan.warnings };
}
