// calendar.md rows (spec/format.md §5): `- 2026-08-01 · checkpoint: review of
// FREEZE-004`. Dated, typed by the word before the colon, and referencing ids
// rather than restating them. Read here so the dashboard's calendar view and
// the release hub's timeline agree on what a row is (TASK-460).

import { findIdReferences } from "./ids.js";

export interface CalendarRow {
  /** the row's `YYYY-MM-DD` */
  date: string;
  /** the row text, minus the date and separator */
  text: string;
  /**
   * The word before the first colon — `checkpoint`, `deadline`, `freeze` — or
   * null when the row does not open that way. Rows are typed by convention,
   * not by a field, so this is a reading and nothing validates it.
   */
  kind: string | null;
  /** IDs the row references — the spec's rule is to reference, never restate */
  refs: string[];
}

/** `- 2026-08-01 · checkpoint: review of FREEZE-004` (spec §5). */
const CALENDAR_ROW_RE = /^-\s+(\d{4}-\d{2}-\d{2})\s*(?:·\s*)?(.*)$/;
/** a short lowercase word (or two) before a colon, e.g. `checkpoint:` or `dev handoff:` */
const KIND_RE = /^([a-z][a-z -]{0,24}):\s/;

/**
 * Dated rows from a calendar body, in file order. Rows that carry no date are
 * skipped rather than guessed at: a deadline the reader invents is worse than
 * one it admits it cannot read.
 */
export function parseCalendarRows(body: string): CalendarRow[] {
  const rows: CalendarRow[] = [];
  for (const line of body.split("\n")) {
    const match = CALENDAR_ROW_RE.exec(line.trim());
    if (!match?.[1]) continue;
    const text = (match[2] ?? "").trim();
    rows.push({
      date: match[1],
      text,
      kind: KIND_RE.exec(text)?.[1] ?? null,
      refs: findIdReferences(text),
    });
  }
  return rows;
}
