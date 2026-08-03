// Feedbacks.md (spec/format.md §4, "Feedbacks.md") — FEEDBACK-### entries,
// flat (no `##` sections).

import {
  type FeedbackSource,
  type FeedbackStatus,
  isFeedbackSource,
  splitStatusLink,
} from "./enums.js";
import { nextId } from "./ids.js";
import {
  appendFlatEntry,
  declaredIds,
  findEntry,
  type LedgerDocument,
  type LedgerEntry,
  parseLedger,
  serializeLedger,
  setEntryField,
} from "./ledger.js";

export function parseFeedbacks(text: string): LedgerDocument {
  return parseLedger(text, { checkbox: false });
}

export function serializeFeedbacks(doc: LedgerDocument): string {
  return serializeLedger(doc);
}

export function nextFeedbackId(doc: LedgerDocument): string {
  return nextId(declaredIds(doc), "FEEDBACK");
}

export interface FeedbackDisposition {
  /** the base status word, e.g. "accepted" */
  status: string;
  /** the linked TASK-### / DDR-### id, when the status carries one (accepted/declined) */
  link: string | null;
}

/** Parses the `status:` field, splitting the "accepted → TASK-042" link syntax. */
export function feedbackDisposition(entry: LedgerEntry): FeedbackDisposition | null {
  const raw = entry.fields.status;
  if (!raw) return null;
  return splitStatusLink(raw);
}

export function feedbackSource(entry: LedgerEntry): FeedbackSource | null {
  const raw = entry.fields.source?.split(/\s+/)[0]; // "review (FREEZE-003)" → "review"
  return raw && isFeedbackSource(raw) ? raw : null;
}

/** The parenthetical id in `source: review (FREEZE-003)`, or null. */
export function feedbackSourceDetail(entry: LedgerEntry): string | null {
  return /\(([A-Z][A-Z0-9]*-\d+)\)/.exec(entry.fields.source ?? "")?.[1] ?? null;
}

export function findFeedback(doc: LedgerDocument, id: string): LedgerEntry | undefined {
  return findEntry(doc, id)?.entry;
}

export interface NewFeedbackInput {
  id: string;
  date: string;
  source: FeedbackSource;
  /** e.g. "FREEZE-003", rendered as `source: review (FREEZE-003)` per spec §4's example */
  sourceDetail?: string;
  from?: string;
  quote?: string;
  status: FeedbackStatus;
  /** the TASK-### / DDR-### this disposition links, when applicable */
  link?: string;
}

/** Builds a FEEDBACK-### entry in the spec §4 shape. */
export function buildFeedbackEntry(input: NewFeedbackInput): LedgerEntry {
  const sourceValue = input.sourceDetail ? `${input.source} (${input.sourceDetail})` : input.source;
  const headerParts = [`source: ${sourceValue}`];
  if (input.from) headerParts.push(`from: ${input.from}`);
  const headerLine = `- ${input.id} — ${input.date} · ${headerParts.join(" · ")}`;

  const lines = [headerLine];
  if (input.quote) lines.push(`  quote: ${JSON.stringify(input.quote)}`);
  const statusValue = input.link ? `${input.status} → ${input.link}` : input.status;
  lines.push(`  status: ${statusValue}`);

  const fields: Record<string, string> = { source: sourceValue, status: statusValue };
  if (input.from) fields.from = input.from;
  if (input.quote) fields.quote = input.quote;

  const refs = [
    input.id,
    ...(input.sourceDetail ? [input.sourceDetail] : []),
    ...(input.from ? [input.from] : []),
    ...(input.link ? [input.link] : []),
  ];

  return { id: input.id, checked: null, date: input.date, title: "", fields, refs, lines };
}

export function addFeedback(doc: LedgerDocument, input: NewFeedbackInput): LedgerEntry {
  const entry = buildFeedbackEntry(input);
  appendFlatEntry(doc, entry);
  return entry;
}

/**
 * Rewrites a feedback entry's disposition (spec §4: `accepted` links the
 * resulting TASK, `declined` links the DDR recording why, `done` keeps the
 * shipped work's link). Only the status line is regenerated.
 */
export function setFeedbackDisposition(
  entry: LedgerEntry,
  status: FeedbackStatus,
  link?: string,
): void {
  setEntryField(entry, "status", link ? `${status} → ${link}` : status);
}
