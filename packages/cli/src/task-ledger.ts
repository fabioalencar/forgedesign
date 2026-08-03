// Reading the task ledger.
//
// Three layouts have existed: v1's `todo/todo.md` (its own grammar), v0.1's
// root `Todos.md`, and v0.2's `design/todos.md` where the ledger is the body of
// a concept. Only the last is read (DDR-095) — the other two are what `forge
// upgrade` migrates *from*, and their readers went with the rule that an
// unmigrated record gets `upgrade` and nothing else. Every surface that counts
// or lists tasks still resolves through here, which is what stopped a migrated
// project reporting zero open tasks because a reader was looking at v1 (T-280).

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  addTask,
  entriesInSection,
  type LedgerDocument,
  nextTaskId,
  parseConcept,
  parseTodos,
  serializeTodos,
  setBody,
} from "@forgedesign/format";
import { bundleRootOf } from "./bundle-index.js";
import { todayIsoDate } from "./freezes.js";
/** One layout is written (DDR-095); the union is kept so callers still name it. */
export type LedgerLayout = "v0.2";

export interface SectionCount {
  section: string;
  open: number;
}

export interface TaskLedgerReading {
  layout: LedgerLayout;
  /** repo-relative path the counts came from */
  relPath: string;
  counts: SectionCount[];
}

async function readIfExists(absPath: string): Promise<string | null> {
  try {
    return await fs.readFile(absPath, "utf8");
  } catch {
    return null;
  }
}

function countsOf(doc: LedgerDocument): SectionCount[] {
  return doc.sections.map((section) => ({
    section: section.heading,
    open: entriesInSection(section).filter((entry) => entry.checked !== true).length,
  }));
}

/** Open-task counts per section, or null when this is not a current record. */
export async function readTaskCounts(root: string): Promise<TaskLedgerReading | null> {
  const recordRoot = await bundleRootOf(root);
  if (recordRoot !== null) {
    const relPath = path.join(recordRoot, "todos.md");
    const text = await readIfExists(path.join(root, relPath));
    if (text !== null) {
      return {
        layout: "v0.2",
        relPath,
        counts: countsOf(parseTodos(parseConcept("todos.md", text).body)),
      };
    }
  }

  return null;
}

export interface NewTask {
  title: string;
  /** what caused this task — a FEEDBACK/QUESTION/DDR id, or a dated source */
  genesis?: string;
  /** the arc it belongs to (DDR-068) */
  phase?: string;
  notes?: string;
  quote?: string;
}

export interface TaskLedgerWriter {
  layout: LedgerLayout;
  relPath: string;
  /** the id this task will get, allocated from the ledger's own numbering */
  add(task: NewTask): string;
  save(): Promise<void>;
}

/**
 * A writer for the bundle ledger, or null when this repo has none. An older
 * layout returns null rather than being written to: rewriting an unmigrated
 * project is `forge upgrade`'s job, not a side effect of accepting an intake
 * item (DDR-095).
 */
export async function openTaskLedger(root: string): Promise<TaskLedgerWriter | null> {
  const recordRoot = await bundleRootOf(root);
  if (recordRoot !== null) {
    const relPath = path.join(recordRoot, "todos.md");
    const abs = path.join(root, relPath);
    const text = await readIfExists(abs);
    if (text !== null) {
      const doc = parseTodos(parseConcept("todos.md", text).body);
      return {
        layout: "v0.2",
        relPath,
        add: (task) => addRecordTask(doc, task),
        save: async () => {
          const current = (await readIfExists(abs)) ?? text;
          await fs.writeFile(abs, setBody(current, serializeTodos(doc)), "utf8");
        },
      };
    }
  }

  return null;
}

function addRecordTask(doc: LedgerDocument, task: NewTask): string {
  const id = nextTaskId(doc);
  addTask(doc, "Todo", {
    id,
    title: task.title,
    status: "todo",
    opened: todayIsoDate(),
    ...(task.phase ? { phase: task.phase } : {}),
    ...(task.genesis ? { genesis: task.genesis } : {}),
    ...(task.notes ? { notes: task.notes } : {}),
  });
  return id;
}
