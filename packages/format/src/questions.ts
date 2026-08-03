// OpenQuestions.md (spec/format.md §4, "OpenQuestions.md") — QUESTION-###
// entries, flat (no `##` sections).

import { splitStatusLink } from "./enums.js";
import { nextId } from "./ids.js";
import {
  appendFlatEntry,
  declaredIds,
  findEntry,
  type LedgerDocument,
  type LedgerEntry,
  parseLedger,
  serializeLedger,
} from "./ledger.js";

export function parseQuestions(text: string): LedgerDocument {
  return parseLedger(text, { checkbox: false });
}

export function serializeQuestions(doc: LedgerDocument): string {
  return serializeLedger(doc);
}

export function nextQuestionId(doc: LedgerDocument): string {
  return nextId(declaredIds(doc), "QUESTION");
}

export interface QuestionResolution {
  status: string;
  /** the DDR-### / FEEDBACK-### / TASK-### that resolved it, when status carries one */
  link: string | null;
}

export function questionResolution(entry: LedgerEntry): QuestionResolution | null {
  const raw = entry.fields.status;
  if (!raw) return null;
  return splitStatusLink(raw);
}

export function findQuestion(doc: LedgerDocument, id: string): LedgerEntry | undefined {
  return findEntry(doc, id)?.entry;
}

export interface NewQuestionInput {
  id: string;
  date: string;
  question: string;
  status: "open" | "resolved" | "dropped";
  link?: string;
  context?: string;
}

/** Builds a QUESTION-### entry in the spec §4 shape. */
export function buildQuestionEntry(input: NewQuestionInput): LedgerEntry {
  const statusValue = input.link ? `${input.status} → ${input.link}` : input.status;
  const headerLine = `- ${input.id} — ${input.date} · status: ${statusValue}`;
  const lines = [headerLine, `  ${input.question}`];
  if (input.context) lines.push(`  context: ${input.context}`);

  const fields: Record<string, string> = { status: statusValue, body: input.question };
  if (input.context) fields.context = input.context;

  const refs = [input.id, ...(input.link ? [input.link] : [])];

  return { id: input.id, checked: null, date: input.date, title: "", fields, refs, lines };
}

export function addQuestion(doc: LedgerDocument, input: NewQuestionInput): LedgerEntry {
  const entry = buildQuestionEntry(input);
  appendFlatEntry(doc, entry);
  return entry;
}
