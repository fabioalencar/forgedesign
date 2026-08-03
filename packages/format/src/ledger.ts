// Generic round-trip-safe parser/serializer for "ledger" files: Markdown
// files where entries are rows (Todos.md, Feedbacks.md, OpenQuestions.md,
// Stakeholders.md, UserRoles.md, UserStories.md, ProcessFlows.md, Calendar.md
// — spec/format.md §2, "ledger files vs document folders").
//
// Mirrors the CLI's existing todo.ts grammar (DDR-007 round-trip contract):
// raw lines are authoritative, so serialize(parse(text)) is byte-identical
// for well-formed input. `fields`/`refs` are derived read-only projections
// for querying (doctor, link resolution) — mutating them does not affect
// serialization; use the block/line-level helpers for that.
//
// Ledgers with no `##` headings (Feedbacks.md, OpenQuestions.md, ...) are
// supported the same way as sectioned ones (Todos.md): entries simply live
// in `preambleBlocks` instead of a named section.

import { findIdReferences } from "./ids.js";

export interface LedgerEntry {
  /** first bare ID token on the header line, or null for un-IDed rows (e.g. Calendar.md) */
  id: string | null;
  /** only meaningful when the grammar is checkbox-style; null otherwise */
  checked: boolean | null;
  /** the `— YYYY-MM-DD` header date (Feedbacks/OpenQuestions shape), or null */
  date: string | null;
  /** free text remaining on the header line after the id (and any leading date/fields) */
  title: string;
  /** key → value, flattened across the header line and continuation lines */
  fields: Record<string, string>;
  /** every bare ID token found anywhere in the entry, including its own id */
  refs: string[];
  /** authoritative raw lines: header line + indented continuation lines */
  lines: string[];
}

export type LedgerBlock = { kind: "raw"; lines: string[] } | { kind: "entry"; entry: LedgerEntry };

export interface LedgerSection {
  heading: string;
  headingLine: string;
  blocks: LedgerBlock[];
}

export interface LedgerDocument {
  /** raw/entry blocks before the first `##` heading — the whole document for flat (sectionless) ledgers */
  preambleBlocks: LedgerBlock[];
  sections: LedgerSection[];
  trailingNewline: boolean;
}

export interface LedgerGrammar {
  /** entries start with `- [ ]`/`- [x]` (Todos.md) instead of a plain `- ` bullet */
  checkbox: boolean;
}

const SECTION_RE = /^##\s+(.+?)\s*$/;
const CHECKBOX_ENTRY_RE = /^- \[( |x|X)\] (.*)$/;
const PLAIN_ENTRY_RE = /^- (.*)$/;
/** continuation line: indented, belongs to the entry above (incl. nested bullets) */
const CONTINUATION_RE = /^\s+\S/;
const FIELD_RE = /^([A-Za-z][\w-]*):\s?(.*)$/;
const LEADING_DATE_RE = /^—\s*(\d{4}-\d{2}-\d{2})\s*/;
// An em dash separates the id from whatever follows it, whether that is a date
// (`— 2026-07-18 · source: …`) or a plain identity (`— Returning customer`).
// Only the dated form was stripped before, so identity-style rows — the shape
// spec §4 gives Stakeholders/UserRoles/UserStories — kept the dash in `title`.
const LEADING_SEPARATOR_RE = /^—\s*/;

function parseHeaderContent(
  content: string,
): Pick<LedgerEntry, "id" | "date" | "title" | "fields"> {
  const refs = findIdReferences(content);
  const id = refs[0] ?? null;
  const afterId = id ? content.slice(content.indexOf(id) + id.length) : content;
  const date = LEADING_DATE_RE.exec(afterId.trim())?.[1] ?? null;
  const stripped = afterId.trim().replace(LEADING_DATE_RE, "").replace(LEADING_SEPARATOR_RE, "");

  const fields: Record<string, string> = {};
  let title = "";
  for (const segment of stripped.split(/\s*·\s*/)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const match = FIELD_RE.exec(trimmed);
    if (match?.[1] !== undefined) {
      fields[match[1]] = (match[2] ?? "").trim();
    } else if (!title) {
      title = trimmed;
    }
  }
  return { id, date, title, fields };
}

/**
 * `key: value` pairs across continuation lines. A continuation line with no
 * colon (e.g. OpenQuestions.md's bare question text) is captured under the
 * synthetic `body` key instead of being dropped.
 */
function parseContinuationFields(lines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const trimmedLine = line.trim();
    let matchedAny = false;
    for (const segment of trimmedLine.split(/\s*·\s*/)) {
      const match = FIELD_RE.exec(segment.trim());
      if (match?.[1] !== undefined) {
        fields[match[1]] = (match[2] ?? "").trim();
        matchedAny = true;
      }
    }
    if (!matchedAny && trimmedLine && fields.body === undefined) fields.body = trimmedLine;
  }
  return fields;
}

function buildEntry(
  headerLine: string,
  checked: boolean | null,
  headerContent: string,
  continuationLines: string[],
): LedgerEntry {
  const header = parseHeaderContent(headerContent);
  const continuationFields = parseContinuationFields(continuationLines);
  const lines = [headerLine, ...continuationLines];
  return {
    id: header.id,
    checked,
    date: header.date,
    title: header.title,
    fields: { ...header.fields, ...continuationFields },
    refs: findIdReferences(lines.join("\n")),
    lines,
  };
}

function matchEntryStart(
  line: string,
  grammar: LedgerGrammar,
): { content: string; checked: boolean | null } | null {
  if (grammar.checkbox) {
    const m = CHECKBOX_ENTRY_RE.exec(line);
    if (!m) return null;
    return { content: m[2] ?? "", checked: m[1] !== " " };
  }
  const m = PLAIN_ENTRY_RE.exec(line);
  if (!m) return null;
  return { content: m[1] ?? "", checked: null };
}

export function parseLedger(text: string, grammar: LedgerGrammar): LedgerDocument {
  const trailingNewline = text.endsWith("\n");
  const lines = trailingNewline ? text.slice(0, -1).split("\n") : text.split("\n");

  const doc: LedgerDocument = { preambleBlocks: [], sections: [], trailingNewline };
  let section: LedgerSection | null = null;

  const currentBlocks = () => section?.blocks ?? doc.preambleBlocks;

  const pushRaw = (line: string) => {
    const blocks = currentBlocks();
    const last = blocks.at(-1);
    if (last?.kind === "raw") last.lines.push(line);
    else blocks.push({ kind: "raw", lines: [line] });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const headingMatch = line.match(SECTION_RE);
    if (headingMatch?.[1]) {
      section = { heading: headingMatch[1], headingLine: line, blocks: [] };
      doc.sections.push(section);
      continue;
    }

    const start = matchEntryStart(line, grammar);
    if (start) {
      const continuationLines: string[] = [];
      while (i + 1 < lines.length && CONTINUATION_RE.test(lines[i + 1]!)) {
        i++;
        continuationLines.push(lines[i]!);
      }
      const entry = buildEntry(line, start.checked, start.content, continuationLines);
      currentBlocks().push({ kind: "entry", entry });
      continue;
    }

    pushRaw(line);
  }

  return doc;
}

export function serializeLedger(doc: LedgerDocument): string {
  const blockLines = (block: LedgerBlock) =>
    block.kind === "raw" ? block.lines : block.entry.lines;
  const out: string[] = doc.preambleBlocks.flatMap(blockLines);
  for (const section of doc.sections) {
    out.push(section.headingLine);
    out.push(...section.blocks.flatMap(blockLines));
  }
  return out.join("\n") + (doc.trailingNewline ? "\n" : "");
}

// --- queries ---

export function findSection(doc: LedgerDocument, heading: string): LedgerSection | undefined {
  return doc.sections.find((s) => s.heading === heading);
}

export function entriesInBlocks(blocks: LedgerBlock[]): LedgerEntry[] {
  return blocks
    .filter((b): b is { kind: "entry"; entry: LedgerEntry } => b.kind === "entry")
    .map((b) => b.entry);
}

export function entriesInSection(section: LedgerSection): LedgerEntry[] {
  return entriesInBlocks(section.blocks);
}

/** All entries across the preamble and every section, in document order. */
export function allEntries(doc: LedgerDocument): LedgerEntry[] {
  return [...entriesInBlocks(doc.preambleBlocks), ...doc.sections.flatMap(entriesInSection)];
}

export function findEntry(
  doc: LedgerDocument,
  id: string,
): { section: LedgerSection | null; entry: LedgerEntry } | undefined {
  for (const entry of entriesInBlocks(doc.preambleBlocks)) {
    if (entry.id === id) return { section: null, entry };
  }
  for (const section of doc.sections) {
    for (const entry of entriesInSection(section)) {
      if (entry.id === id) return { section, entry };
    }
  }
  return undefined;
}

/** Every id declared by an entry in this document (nulls excluded). */
export function declaredIds(doc: LedgerDocument): string[] {
  return allEntries(doc)
    .map((e) => e.id)
    .filter((id): id is string => id !== null);
}

/** Every id referenced anywhere in this document, including the entries' own ids. */
export function referencedIds(doc: LedgerDocument): string[] {
  return allEntries(doc).flatMap((e) => e.refs);
}

// --- mutation helpers ---

function isBlankRaw(block: LedgerBlock): boolean {
  return block.kind === "raw" && block.lines.every((l) => l.trim() === "");
}

function getOrCreateSection(doc: LedgerDocument, heading: string): LedgerSection {
  let section = findSection(doc, heading);
  if (section) return section;
  const lastBlock = doc.sections.at(-1)?.blocks.at(-1) ?? doc.preambleBlocks.at(-1);
  if (lastBlock && !isBlankRaw(lastBlock)) {
    const target = doc.sections.at(-1)?.blocks ?? doc.preambleBlocks;
    target.push({ kind: "raw", lines: [""] });
  }
  section = { heading, headingLine: `## ${heading}`, blocks: [] };
  doc.sections.push(section);
  return section;
}

/** Appends after a section's last content, keeping trailing blank lines where they were. */
export function appendEntry(doc: LedgerDocument, sectionHeading: string, entry: LedgerEntry): void {
  const section = getOrCreateSection(doc, sectionHeading);
  let end = section.blocks.length;
  while (end > 0 && isBlankRaw(section.blocks[end - 1]!)) end--;
  const trailing = section.blocks.splice(end);
  const lastContent = section.blocks.at(-1);
  if (lastContent?.kind !== "entry") {
    section.blocks.push({ kind: "raw", lines: [""] });
  }
  section.blocks.push({ kind: "entry", entry });
  section.blocks.push(...trailing);
}

/** Appends an entry directly to the flat/preamble document (no `##` sections). */
export function appendFlatEntry(doc: LedgerDocument, entry: LedgerEntry): void {
  const blocks = doc.preambleBlocks;
  if (blocks.length > 0 && !isBlankRaw(blocks.at(-1)!)) {
    blocks.push({ kind: "raw", lines: [""] });
  }
  blocks.push({ kind: "entry", entry });
}

/**
 * Rebuilds an entry's derived projections (fields/refs/title) from its own
 * raw lines after a line-level mutation. Mutates in place so the entry keeps
 * its object identity inside the document.
 */
function reprojectEntry(entry: LedgerEntry): void {
  const grammar: LedgerGrammar = { checkbox: entry.checked !== null };
  const reparsed = allEntries(parseLedger(`${entry.lines.join("\n")}\n`, grammar))[0];
  if (!reparsed) throw new Error(`entry ${entry.id ?? "(no id)"} no longer parses as an entry`);
  entry.id = reparsed.id;
  entry.checked = reparsed.checked;
  entry.date = reparsed.date;
  entry.title = reparsed.title;
  entry.fields = reparsed.fields;
  entry.refs = reparsed.refs;
}

/**
 * Sets a `key: value` field, regenerating only the line it lives on
 * (DDR-007: raw lines are authoritative; untouched lines stay byte-identical).
 * Composite lines (`status: doing · opened: 2026-07-20`) keep their other
 * segments — only the matching segment's value changes. A field that doesn't
 * exist yet is appended as a new continuation line after the last field line.
 */
export function setEntryField(entry: LedgerEntry, key: string, value: string): void {
  const fieldRe = /^([A-Za-z][\w-]*):\s?/;
  const replaceInLine = (line: string): string | null => {
    const segments = line.split(/\s*·\s*/);
    const index = segments.findIndex((segment) => {
      const m = fieldRe.exec(segment.trim());
      return m?.[1] === key;
    });
    if (index === -1) return null;
    const indent = line.match(/^\s*/)?.[0] ?? "";
    segments[index] = `${key}: ${value}`;
    return indent + segments.map((s) => s.trim()).join(" · ");
  };

  // Continuation lines first (task/feedback status), then the header line
  // (question status lives inline after the date).
  for (let i = entry.lines.length - 1; i >= 0; i--) {
    const replaced = replaceInLine(entry.lines[i]!);
    if (replaced !== null) {
      entry.lines[i] = replaced;
      reprojectEntry(entry);
      return;
    }
  }

  // Not present: insert after the last continuation line that carries a field.
  const indent = entry.lines[1]?.match(/^\s*/)?.[0] ?? "  ";
  let insertAt = 1;
  for (let i = entry.lines.length - 1; i >= 1; i--) {
    if (/^\s+[A-Za-z][\w-]*:\s?/.test(entry.lines[i]!)) {
      insertAt = i + 1;
      break;
    }
  }
  entry.lines.splice(insertAt, 0, `${indent}${key}: ${value}`.trimEnd());
  reprojectEntry(entry);
}

/** Rewrites a checkbox entry's `- [ ]`/`- [x]` marker. No-op on plain-bullet entries. */
export function setEntryChecked(entry: LedgerEntry, checked: boolean): void {
  if (entry.checked === null || entry.checked === checked) return;
  entry.lines[0] = entry.lines[0]!.replace(/^- \[( |x|X)\]/, `- [${checked ? "x" : " "}]`);
  entry.checked = checked;
}

/**
 * Moves an entry's block verbatim to the end of another section (created if
 * missing — callers gate on legal headings). Collapses the blank line left
 * behind so the source section doesn't accumulate gaps.
 */
export function moveEntry(doc: LedgerDocument, id: string, targetHeading: string): boolean {
  const located = findEntry(doc, id);
  if (!located) return false;

  const sourceBlocks = located.section?.blocks ?? doc.preambleBlocks;
  const index = sourceBlocks.findIndex((b) => b.kind === "entry" && b.entry.id === id);
  sourceBlocks.splice(index, 1);
  const before = sourceBlocks[index - 1];
  const after = sourceBlocks[index];
  if (before && after && isBlankRaw(before) && isBlankRaw(after)) {
    sourceBlocks.splice(index, 1);
  } else if (before && !after && isBlankRaw(before)) {
    sourceBlocks.splice(index - 1, 1);
  }

  appendEntry(doc, targetHeading, located.entry);
  return true;
}
