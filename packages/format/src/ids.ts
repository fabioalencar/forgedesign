// Descriptive stable IDs (spec/format.md §3): PREFIX-NNN, uppercase prefix,
// zero-padded number, immutable and never reused.

export const RESERVED_PREFIXES = [
  "TASK",
  "DDR",
  "FEEDBACK",
  "STAKEHOLDER",
  "STORY",
  "QUESTION",
  "ROLE",
  "FLOW",
  "FREEZE",
  "SCENARIO",
] as const;

export type ReservedPrefix = (typeof RESERVED_PREFIXES)[number];

export function isReservedPrefix(prefix: string): prefix is ReservedPrefix {
  return (RESERVED_PREFIXES as readonly string[]).includes(prefix);
}

export interface ParsedId {
  prefix: string;
  number: number;
  raw: string;
}

const ID_RE = /^([A-Z][A-Z0-9]*)-(\d+)$/;

/**
 * A bare-ID token anywhere in free text (spec §5: cross-references are bare
 * IDs). Only the reserved prefixes count, because spec §4 is what defines an
 * ID and it names them: anything else with the same shape is a standard, a
 * codec or a version — `UTF-8`, `ISO-8601`, `HTTP-2` — and asking prose to stop
 * mentioning those is the linter wagging the record (DDR-071).
 *
 * Deliberately narrower than `parseId`, which validates an ID it was handed and
 * still accepts any prefix: reading `T-042` out of an un-migrated v1 ledger is
 * a different job from deciding what a sentence refers to.
 */
export const ID_REFERENCE_RE = new RegExp(`\\b((?:${RESERVED_PREFIXES.join("|")})-\\d+)\\b`, "g");

export function parseId(id: string): ParsedId | null {
  const match = ID_RE.exec(id.trim());
  if (!match?.[1] || !match[2]) return null;
  return { prefix: match[1], number: Number.parseInt(match[2], 10), raw: id.trim() };
}

export function formatId(prefix: string, number: number): string {
  return `${prefix}-${String(number).padStart(3, "0")}`;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})/;
/** A run of N backticks, whatever it encloses, up to the next run of the same length. */
const CODE_SPAN_RE = /(`+)[\s\S]*?\1/g;

/**
 * Blanks out fenced blocks and inline code spans. Code is quoted, not cited: a
 * record that documents the format writes `TASK-001` as an example of an ID's
 * shape, and a fixture's `FLOW-002` named in a note belongs to another record
 * entirely — neither is a claim that this record holds that concept (DDR-069).
 *
 * The trade is real and deliberate: backticking an ID you *did* mean as a
 * reference hides it from doctor. Backticks are the escape hatch, so writing
 * one is how you say "literal".
 */
function withoutCode(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = FENCE_RE.exec(line)?.[1];
    if (fence === null) {
      if (marker) fence = marker[0]!;
      else {
        kept.push(line);
        continue;
      }
    } else if (marker?.startsWith(fence)) {
      fence = null;
    }
    kept.push("");
  }
  return kept.join("\n").replace(CODE_SPAN_RE, " ");
}

/** Every bare-ID token found in `text`, in order of appearance (duplicates kept). */
export function findIdReferences(text: string): string[] {
  return [...withoutCode(text).matchAll(ID_REFERENCE_RE)].map((m) => m[1]!);
}

/**
 * Next unused id for `prefix`, scanning the max existing number across
 * `existingIds` and adding one (spec: numbering is per-prefix, monotonic,
 * assigned at creation — never renumber).
 */
export function nextId(existingIds: Iterable<string>, prefix: string): string {
  let max = 0;
  for (const id of existingIds) {
    const parsed = parseId(id);
    if (parsed && parsed.prefix === prefix && parsed.number > max) max = parsed.number;
  }
  return formatId(prefix, max + 1);
}
