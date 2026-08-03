// Todos.md (spec/format.md §4, "Todos.md") — TASK-### entries, sections
// `## Todo` / `## Doing` / `## Done` / `## Deferred`.

import { isTaskStatus, type TaskStatus } from "./enums.js";
import { nextId } from "./ids.js";
import {
  appendEntry,
  declaredIds,
  findEntry,
  type LedgerDocument,
  type LedgerEntry,
  moveEntry,
  parseLedger,
  serializeLedger,
  setEntryChecked,
  setEntryField,
} from "./ledger.js";

export const TASK_SECTIONS = ["Todo", "Doing", "Done", "Deferred"] as const;
export type TaskSection = (typeof TASK_SECTIONS)[number];

export function parseTodos(text: string): LedgerDocument {
  return parseLedger(text, { checkbox: true });
}

export function serializeTodos(doc: LedgerDocument): string {
  return serializeLedger(doc);
}

export function nextTaskId(doc: LedgerDocument): string {
  return nextId(declaredIds(doc), "TASK");
}

export interface TaskView {
  id: string;
  checked: boolean;
  title: string;
  status: TaskStatus | null;
  opened: string | null;
  /** the arc this task belongs to; free text, grouped on by exact match (DDR-068) */
  phase: string | null;
  genesis: string | null;
  notes: string | null;
}

/** Structured projection of a TASK-### entry's known fields, for read-only consumers. */
export function taskView(entry: LedgerEntry): TaskView {
  const status = entry.fields.status;
  return {
    id: entry.id ?? "",
    checked: entry.checked ?? false,
    title: entry.title,
    status: status && isTaskStatus(status) ? status : null,
    opened: entry.fields.opened ?? null,
    phase: entry.fields.phase ?? null,
    genesis: entry.fields.genesis ?? null,
    notes: entry.fields.notes ?? null,
  };
}

export function findTask(doc: LedgerDocument, id: string): LedgerEntry | undefined {
  return findEntry(doc, id)?.entry;
}

export interface NewTaskInput {
  id: string;
  title: string;
  checked?: boolean;
  status: TaskStatus;
  opened: string;
  phase?: string;
  genesis?: string;
  notes?: string;
}

/** Builds a TASK-### entry in the spec §4 shape (status+opened combined on one line). */
export function buildTaskEntry(input: NewTaskInput): LedgerEntry {
  const checked = input.checked ?? false;
  const headerLine = `- [${checked ? "x" : " "}] ${input.id} ${input.title}`.trimEnd();
  const lines = [headerLine, `  status: ${input.status} · opened: ${input.opened}`];
  if (input.phase) lines.push(`  phase: ${input.phase}`);
  if (input.genesis) lines.push(`  genesis: ${input.genesis}`);
  if (input.notes) lines.push(`  notes: ${input.notes}`);

  const fields: Record<string, string> = { status: input.status, opened: input.opened };
  if (input.phase) fields.phase = input.phase;
  if (input.genesis) fields.genesis = input.genesis;
  if (input.notes) fields.notes = input.notes;

  return {
    id: input.id,
    checked,
    date: null,
    title: input.title,
    fields,
    refs: [input.id, ...(input.genesis ? [input.genesis] : [])],
    lines,
  };
}

/** Appends a new task to the given section (`Todo`, `Doing`, `Done`, or `Deferred`). */
export function addTask(
  doc: LedgerDocument,
  section: TaskSection,
  input: NewTaskInput,
): LedgerEntry {
  const entry = buildTaskEntry(input);
  appendEntry(doc, section, entry);
  return entry;
}

/**
 * The kanban drag as a file edit (DDR-050): moves the task under the target
 * section and keeps section, `status:` field, and checkbox mutually
 * consistent, so `forge doctor` still passes afterwards. Only the moved
 * entry's own lines change. Returns false on unknown id.
 */
export function setTaskSection(doc: LedgerDocument, id: string, section: TaskSection): boolean {
  const located = findEntry(doc, id);
  if (!located?.entry) return false;
  if (located.section?.heading !== section && !moveEntry(doc, id, section)) return false;
  setEntryField(located.entry, "status", section.toLowerCase());
  setEntryChecked(located.entry, section === "Done");
  return true;
}
