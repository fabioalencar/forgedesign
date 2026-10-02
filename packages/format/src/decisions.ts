// decisions/DDR-###-slug.md (spec/format.md §4, "decisions/DDR-###-slug.md")
// — one document per decision, not a ledger row. Parsing here is read-only
// projection; DDRs are edited by hand (or a skill) and re-read, never
// round-trip-serialized by this module.

import { type ParsedDdrStatus, parseDdrStatus } from "./enums.js";
import { findIdReferences } from "./ids.js";

const FILENAME_RE = /^(DDR-\d+)-([a-z0-9-]+)\.md$/;
const TITLE_RE = /^#\s+(DDR-\d+)\s+—\s+(.+?)\s*$/;
const STATUS_RE = /^-\s+\*\*Status\*\*:\s*(.+?)\s*$/;
const DATE_RE = /^-\s+\*\*Date\*\*:\s*(.+?)\s*$/;
const CONTEXT_SOURCE_RE = /^-\s+\*\*Context source\*\*:\s*(.+?)\s*$/;

export interface DdrFilename {
  id: string;
  slug: string;
}

export function parseDdrFilename(filename: string): DdrFilename | null {
  const match = FILENAME_RE.exec(filename);
  if (!match?.[1] || !match[2]) return null;
  return { id: match[1], slug: match[2] };
}

export interface DdrDocument {
  /** null when the H1 doesn't match the expected `# DDR-### — Title` shape */
  id: string | null;
  title: string;
  /** raw Status field value, e.g. "accepted" or "superseded (by DDR-050)" */
  statusRaw: string | null;
  status: ParsedDdrStatus | null;
  date: string | null;
  contextSource: string | null;
  /** every bare ID token referenced anywhere in the document, including its own id */
  refs: string[];
  /** the full source text, unmodified — the immutability check diffs this against git history */
  raw: string;
}

/**
 * The `## Decision` section of a decision body — the one paragraph a reader
 * wants first. Everything under the heading up to the next `##`; the paragraph
 * is usually hard-wrapped, so it runs over several lines, not one. Shared by
 * the hub and the handoff pack so they cannot disagree about what it is.
 */
export function decisionParagraph(body: string): string {
  const start = body.search(/^##\s+Decision\s*$/m);
  if (start < 0) return "";
  const under = body.slice(start).replace(/^##[^\n]*\n?/, "");
  const next = under.search(/^##\s/m);
  return (next < 0 ? under : under.slice(0, next)).trim();
}

export function parseDecision(text: string): DdrDocument {
  const lines = text.split("\n");
  let id: string | null = null;
  let title = "";
  let statusRaw: string | null = null;
  let date: string | null = null;
  let contextSource: string | null = null;

  for (const line of lines) {
    const titleMatch = TITLE_RE.exec(line);
    if (titleMatch?.[1] && titleMatch[2]) {
      id = titleMatch[1];
      title = titleMatch[2];
      continue;
    }
    const statusMatch = STATUS_RE.exec(line);
    if (statusMatch?.[1]) {
      statusRaw = statusMatch[1];
      continue;
    }
    const dateMatch = DATE_RE.exec(line);
    if (dateMatch?.[1]) {
      date = dateMatch[1];
      continue;
    }
    const contextMatch = CONTEXT_SOURCE_RE.exec(line);
    if (contextMatch?.[1]) contextSource = contextMatch[1];
  }

  return {
    id,
    title,
    statusRaw,
    status: statusRaw ? parseDdrStatus(statusRaw) : null,
    date,
    contextSource,
    refs: findIdReferences(text),
    raw: text,
  };
}
