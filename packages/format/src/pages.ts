// pages.md rows (spec §5, DDR-130): `- /register · Sign up — FLOW-001, STORY-003`.
//
// One row per page the prototype has, keyed by its route — the same identity
// `freezes.json#routes` records and a feedback's `route` carries, so nothing
// here invents a second name for a screen. A row is declared intent: what the
// page is called and which flows, stories or tasks touch it. Which screens
// *changed* is never read from here; the build says that (DDR-121), and the
// feature log prints this beside it.
//
// The route is kept as written. Normalising it (`/register/` → `/register`) is
// the reader's job, because the normaliser lives with the build-side code that
// hashes routes, and the two must agree.

import { findIdReferences } from "./ids.js";

export interface PageRow {
  /** as written, backticks stripped — root-relative, unnormalised */
  route: string;
  /** the text after the separator, up to the first ` — ` */
  title: string;
  /** ids the row references — the flows, stories and tasks that touch the page */
  refs: string[];
  /** 1-based line within the body, for doctor to point at */
  line: number;
}

export interface PageRowProblem {
  line: number;
  message: string;
}

export interface ParsedPages {
  rows: PageRow[];
  /** bullets that are not page rows — reported, never guessed at */
  problems: PageRowProblem[];
}

/** `- /route · Title …` — the route may sit in backticks, as it does in the feature log. */
const PAGE_ROW_RE = /^-\s+`?([^\s`·]+)`?\s*·\s*(.+)$/;

/**
 * Every page row in a manifest body, in file order, and every bullet that
 * failed to be one.
 *
 * Only bullets are read: prose, headings and the starter comment `forge add`
 * writes are not rows and are not problems. A bullet that does not parse *is*
 * a problem rather than a skipped line, unlike the calendar's undated rows —
 * a manifest with a malformed row is a manifest that lies about a page, and
 * doctor should say so.
 */
export function parsePageRows(body: string): ParsedPages {
  const rows: PageRow[] = [];
  const problems: PageRowProblem[] = [];
  body.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line.startsWith("- ")) return;
    const number = index + 1;
    const match = PAGE_ROW_RE.exec(line);
    if (!match?.[1] || !match[2]) {
      problems.push({
        line: number,
        message: `not a page row — expected \`- /route · Title\`: ${line.slice(0, 80)}`,
      });
      return;
    }
    const route = match[1];
    if (!route.startsWith("/")) {
      problems.push({
        line: number,
        message: `a route is root-relative and starts with \`/\`: ${route}`,
      });
      return;
    }
    const rest = match[2].trim();
    rows.push({
      route,
      title: (rest.split(" — ")[0] ?? rest).trim(),
      refs: findIdReferences(rest),
      line: number,
    });
  });
  return { rows, problems };
}
