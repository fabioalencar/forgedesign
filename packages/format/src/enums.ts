// Enum values fixed by spec/format.md §3–§5 — checked by `forge doctor`.

/**
 * OKF's own document-lifecycle enum (OKF §5.4), distinct from every Forge
 * domain status below. v0.2 keeps `status` OKF-pure and puts domain state in
 * per-type fields so a generic OKF consumer reads lifecycle correctly (DDR-060).
 * Absent `status` means `stable`.
 */
export const OKF_STATUSES = ["draft", "stable", "deprecated"] as const;
export type OkfStatus = (typeof OKF_STATUSES)[number];
export function isOkfStatus(value: string): value is OkfStatus {
  return (OKF_STATUSES as readonly string[]).includes(value);
}

export const TASK_STATUSES = ["todo", "doing", "done", "deferred"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export const FEEDBACK_STATUSES = ["pending", "accepted", "declined", "deferred", "done"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
export function isFeedbackStatus(value: string): value is FeedbackStatus {
  return (FEEDBACK_STATUSES as readonly string[]).includes(value);
}

/** `figma` and `issue` are imported batches (TASK-463, DDR-124): a comment on a Figma file, an issue in a tracker. */
export const FEEDBACK_SOURCES = [
  "meeting",
  "email",
  "chat",
  "review",
  "scan",
  "figma",
  "issue",
] as const;
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];
export function isFeedbackSource(value: string): value is FeedbackSource {
  return (FEEDBACK_SOURCES as readonly string[]).includes(value);
}

export const QUESTION_STATUSES = ["open", "resolved", "dropped"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
export function isQuestionStatus(value: string): value is QuestionStatus {
  return (QUESTION_STATUSES as readonly string[]).includes(value);
}

/**
 * How far a decision reaches (spec §5, TASK-457): `project` is about this
 * product, its users, brand or constraints; `general` would hold on a project
 * with a different client. Optional on the file — absent means `project`.
 */
export const DECISION_REACHES = ["project", "general"] as const;
export type DecisionReach = (typeof DECISION_REACHES)[number];
export const DEFAULT_DECISION_REACH: DecisionReach = "project";
export function isDecisionReach(value: string): value is DecisionReach {
  return (DECISION_REACHES as readonly string[]).includes(value);
}

/**
 * Who may see a concept when the record is published (spec §3, DDR-128):
 * the creator only, or the stakeholders a freeze is sent to. Optional on the
 * file; each type has a default, and `audienceOf` in concepts.ts applies it.
 */
export const AUDIENCES = ["owner", "stakeholders"] as const;
export type Audience = (typeof AUDIENCES)[number];
export function isAudience(value: string): value is Audience {
  return (AUDIENCES as readonly string[]).includes(value);
}

/** DDR status is `draft | accepted | superseded (by DDR-###)` — the suffix carries a link. */
export const DDR_BASE_STATUSES = ["draft", "accepted", "superseded"] as const;
export type DdrBaseStatus = (typeof DDR_BASE_STATUSES)[number];

export interface ParsedDdrStatus {
  base: DdrBaseStatus;
  /** the DDR-### this one was superseded by, when base === "superseded" */
  supersededBy: string | null;
  /** prose written after a `·`/`—` separator, e.g. "refines DDR-055" — null when absent */
  qualifier: string | null;
}

const SUPERSEDED_RE = /^superseded\s*\(by\s+(DDR-\d+)\)$/i;
/** A status word followed by ` · ` or ` — ` and an explanation of the nuance. */
const QUALIFIED_RE = /^([^·—]+?)\s+[·—]\s+(\S.*)$/s;

/**
 * Reads a `- **Status**:` value. Authors qualify the word — "accepted · refines
 * DDR-055", "accepted — the styling clause is superseded, the rest holds" — and
 * a parser that only accepts the bare enum reads those as unparseable, which
 * during migration silently demotes an accepted decision to a draft. The base
 * word decides the enum; the qualifier is handed back so callers can keep the
 * prose rather than delete it.
 */
export function parseDdrStatus(value: string): ParsedDdrStatus | null {
  const trimmed = value.trim();
  const qualified = QUALIFIED_RE.exec(trimmed);
  const base = qualified?.[1]?.trim() ?? trimmed;
  const qualifier = qualified?.[2]?.trim() ?? null;

  if (base === "draft" || base === "accepted") return { base, supersededBy: null, qualifier };
  const match = SUPERSEDED_RE.exec(base);
  if (match?.[1]) return { base: "superseded", supersededBy: match[1], qualifier };
  return null;
}

/** Splits a "status: value → LINK-ID" style value into its base word and link, if any. */
export function splitStatusLink(value: string): { status: string; link: string | null } {
  const [status, link] = value.split("→").map((s) => s.trim());
  return { status: status ?? value.trim(), link: link || null };
}
