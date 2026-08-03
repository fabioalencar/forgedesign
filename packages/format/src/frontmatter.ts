// YAML frontmatter (spec/format.md §3). Every v0.2 concept file opens with a
// YAML block, and OKF's first conformance criterion is that the block parses at
// all — so this module reports "no block", "block that isn't YAML", and "block
// that isn't a mapping" as three different answers. A subset parser could not
// tell the second apart from YAML it simply didn't cover, which is why the
// package takes a real YAML implementation (DDR-061).

import { Document, parseDocument } from "yaml";

const FENCE = "---";

export interface FrontmatterSplit {
  /** YAML source between the fences, without them; null when there is no block */
  raw: string | null;
  /** everything after the closing fence */
  body: string;
  /** a file that opens with `---` but never closes it */
  unterminated: boolean;
}

export type FrontmatterParse =
  | { kind: "ok"; data: Record<string, unknown>; body: string }
  | { kind: "missing"; body: string }
  | { kind: "invalid"; message: string; body: string };

/**
 * Splits a file into its frontmatter block and body without interpreting the
 * YAML. The opening fence must be the very first line: a `---` further down is
 * a thematic break in the body, not a delayed frontmatter block.
 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const source = text.startsWith("﻿") ? text.slice(1) : text;
  const lines = source.split("\n");
  if (stripCr(lines[0] ?? "") !== FENCE) return { raw: null, body: source, unterminated: false };

  for (let i = 1; i < lines.length; i++) {
    if (stripCr(lines[i] ?? "") !== FENCE) continue;
    return {
      // The YAML block is normalized to LF: a checkout with CRLF endings would
      // otherwise leave a trailing carriage return inside every scalar, so
      // `type: Feedback` would read as "Feedback\r" and match no vocabulary.
      // The body is returned verbatim — it round-trips through edits.
      raw: lines.slice(1, i).map(stripCr).join("\n"),
      body: lines.slice(i + 1).join("\n"),
      unterminated: false,
    };
  }
  return { raw: null, body: source, unterminated: true };
}

export function parseFrontmatter(text: string): FrontmatterParse {
  const split = splitFrontmatter(text);
  if (split.unterminated) {
    return {
      kind: "invalid",
      message: "frontmatter block is never closed by a `---` line",
      body: split.body,
    };
  }
  if (split.raw === null) return { kind: "missing", body: split.body };

  const doc = parseDocument(split.raw);
  const error = doc.errors[0];
  if (error) return { kind: "invalid", message: error.message, body: split.body };

  const value: unknown = doc.toJS() ?? {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      kind: "invalid",
      message: "frontmatter must be a mapping of keys to values",
      body: split.body,
    };
  }
  return { kind: "ok", data: value as Record<string, unknown>, body: split.body };
}

/**
 * Rewrites frontmatter keys in place, preserving comments, key order, and
 * formatting for everything untouched — the point of DDR-061's dependency, and
 * what keeps a one-field edit a one-line diff. A key set to `undefined` is
 * deleted. Creates the block when the file has none.
 *
 * Throws on a file whose existing block is unparseable: overwriting YAML we
 * cannot read would discard whatever the author meant by it.
 */
export function setFrontmatterFields(text: string, updates: Record<string, unknown>): string {
  const split = splitFrontmatter(text);
  if (split.unterminated) throw new Error("cannot edit frontmatter: block is never closed");

  const doc = editableDocument(split.raw);
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) doc.delete(key);
    else doc.set(key, value);
  }

  const yaml = doc.toString();
  const block = yaml.endsWith("\n") ? yaml : `${yaml}\n`;
  return `${FENCE}\n${block}${FENCE}\n${split.body}`;
}

/**
 * Replaces a concept's body, leaving its frontmatter byte-for-byte intact.
 * `design/todos.md` is the case this exists for: the ledger inside it is
 * rewritten on every board move, and the frontmatter above it must not be
 * reformatted by the round trip.
 */
export function setBody(text: string, body: string): string {
  const split = splitFrontmatter(text);
  if (split.unterminated) throw new Error("cannot replace body: frontmatter block is never closed");
  if (split.raw === null) return body;
  const block = split.raw === "" ? "" : `${split.raw}\n`;
  return `${FENCE}\n${block}${FENCE}\n${body}`;
}

/**
 * Renders a fenced frontmatter block from scratch, in the key order given.
 * Keys whose value is `undefined` are omitted, so callers can pass optional
 * fields without branching. Prefer this over `setFrontmatterFields` on a bare
 * body: a body that happens to open with `---` would otherwise be mistaken for
 * an existing block.
 */
export function buildFrontmatter(fields: Record<string, unknown>): string {
  const doc = new Document({});
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) doc.set(key, value);
  }
  const yaml = doc.toString();
  const block = yaml.endsWith("\n") ? yaml : `${yaml}\n`;
  return `${FENCE}\n${block}${FENCE}\n`;
}

/** A concept file: a frontmatter block followed by its markdown body. */
export function withFrontmatter(fields: Record<string, unknown>, body: string): string {
  return `${buildFrontmatter(fields)}${body}`;
}

/**
 * A document whose keys can be set: the parsed one when there is YAML to
 * preserve, a fresh mapping otherwise. A block holding only comments parses to
 * null contents and cannot take a key — there is no data to keep, so it starts
 * over rather than failing the edit.
 */
function editableDocument(raw: string | null): Document {
  if (raw === null || raw.trim() === "") return new Document({});
  const doc = parseDocument(raw);
  const error = doc.errors[0];
  if (error) throw new Error(`cannot edit frontmatter: ${error.message}`);
  return doc.contents === null ? new Document({}) : doc;
}

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
