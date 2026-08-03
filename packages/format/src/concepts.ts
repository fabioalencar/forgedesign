// Concept documents (spec/format.md §2–§4). Under v0.2 every knowledge fact is
// one file: OKF-required `type` frontmatter, a Forge `id` matching the filename,
// and a domain status field kept separate from OKF's own `status` (DDR-060).
//
// Parsing is pure and never throws: a malformed concept comes back with its
// problems listed, so doctor renders findings and the renderer can still show
// what it managed to read. Validation lives here rather than in doctor so the
// CLI, the renderer, and the skills cannot disagree about what the format says.

import {
  DDR_BASE_STATUSES,
  FEEDBACK_STATUSES,
  OKF_STATUSES,
  type OkfStatus,
  QUESTION_STATUSES,
} from "./enums.js";
import { parseFrontmatter } from "./frontmatter.js";
import { findIdReferences, parseId } from "./ids.js";

/** The `type` vocabulary this profile fixes (spec §2). OKF leaves types free-form. */
export const CONCEPT_TYPES = [
  "Brief",
  "Task Ledger",
  "Calendar",
  "Data Model",
  "Design System",
  "Component Inventory",
  "Feature Log",
  "Decision",
  "Feedback",
  "Question",
  "Story",
  "Role",
  "Stakeholder",
  "Term",
  "Flow",
  "Scenario",
] as const;

export type ConceptType = (typeof CONCEPT_TYPES)[number];

export function isConceptType(value: string): value is ConceptType {
  return (CONCEPT_TYPES as readonly string[]).includes(value);
}

/** Types whose concepts carry a `PREFIX-NNN` id, and the prefix each uses. */
export const ID_BEARING_TYPES: Partial<Record<ConceptType, string>> = {
  Decision: "DDR",
  Feedback: "FEEDBACK",
  Question: "QUESTION",
  Story: "STORY",
  Role: "ROLE",
  Stakeholder: "STAKEHOLDER",
  Flow: "FLOW",
  Scenario: "SCENARIO",
};

/**
 * The domain status field for each type, and its legal values (spec §3, "Status:
 * two fields, on purpose"). OKF's `status` means document lifecycle and keeps
 * its own enum; these answer the domain question instead.
 */
export const DOMAIN_STATUS_FIELDS: Partial<
  Record<ConceptType, { field: string; values: readonly string[] }>
> = {
  Decision: { field: "decision_status", values: DDR_BASE_STATUSES },
  Feedback: { field: "feedback_status", values: FEEDBACK_STATUSES },
  Question: { field: "question_status", values: QUESTION_STATUSES },
};

/** Which directory under the bundle root holds each ID-bearing type (spec §2). */
export const TYPE_DIRECTORIES: Partial<Record<ConceptType, string>> = {
  Decision: "decisions",
  Feedback: "feedback",
  Question: "questions",
  Story: "stories",
  Role: "roles",
  Stakeholder: "stakeholders",
  Term: "glossary",
  Flow: "flows",
  Scenario: "scenarios",
};

/** Bundle-root files and the type each must declare (spec §2). */
export const ROOT_CONCEPT_FILES: Record<string, ConceptType> = {
  "brief.md": "Brief",
  "todos.md": "Task Ledger",
  "calendar.md": "Calendar",
  "data-model.md": "Data Model",
  "design-system.md": "Design System",
  "components.md": "Component Inventory",
  "feature-log.md": "Feature Log",
};

export interface ConceptSource {
  resource: string;
  title?: string;
  id?: string;
}

/** An OKF actor stamp: `{ by, at }` (§5.2). */
export interface ActorStamp {
  by: string;
  at: string | null;
}

export type ConceptProblemKind =
  | "frontmatter-missing"
  | "frontmatter-invalid"
  | "type-missing"
  | "type-unknown"
  | "type-mismatched-directory"
  | "id-missing"
  | "id-malformed"
  | "id-filename-mismatch"
  | "status-invalid"
  | "domain-status-invalid";

export interface ConceptProblem {
  kind: ConceptProblemKind;
  message: string;
}

export interface ParsedConcept {
  /** path relative to the bundle root, e.g. "feedback/FEEDBACK-011.md" */
  relPath: string;
  /** OKF concept id: the path with `.md` removed (§2 terminology) */
  conceptId: string;
  type: string | null;
  id: string | null;
  title: string | null;
  description: string | null;
  date: string | null;
  /** OKF document lifecycle; absent means `stable` per OKF §5.4 */
  status: OkfStatus;
  /** the type's own state field, when it declares one */
  domainStatus: { field: string; value: string } | null;
  sources: ConceptSource[];
  generated: ActorStamp | null;
  verified: ActorStamp[];
  /** every frontmatter key, including ones this profile does not name */
  frontmatter: Record<string, unknown>;
  body: string;
  /** the full source text, unmodified — doctor's immutability checks diff this against git */
  raw: string;
  /** bare ID tokens referenced anywhere in the file, frontmatter included */
  refs: string[];
  problems: ConceptProblem[];
}

export function conceptIdFromPath(relPath: string): string {
  return relPath.replace(/\.md$/, "");
}

export function parseConcept(relPath: string, text: string): ParsedConcept {
  const problems: ConceptProblem[] = [];
  const parsed = parseFrontmatter(text);

  if (parsed.kind === "missing") {
    problems.push({
      kind: "frontmatter-missing",
      message: "no YAML frontmatter block; every concept must open with one",
    });
  } else if (parsed.kind === "invalid") {
    problems.push({ kind: "frontmatter-invalid", message: parsed.message });
  }

  const data = parsed.kind === "ok" ? parsed.data : {};
  const type = readString(data.type);
  const id = readString(data.id);

  if (parsed.kind === "ok" && !type) {
    problems.push({ kind: "type-missing", message: "frontmatter has no `type`" });
  } else if (type && !isConceptType(type)) {
    problems.push({
      kind: "type-unknown",
      message: `\`type: ${type}\` is not in the spec §2 vocabulary`,
    });
  }

  if (type && isConceptType(type)) {
    checkDirectory(relPath, type, problems);
    checkId(relPath, type, id, problems);
  }

  const status = readStatus(data.status, problems);
  const domainStatus = readDomainStatus(type, data, problems);

  return {
    relPath,
    conceptId: conceptIdFromPath(relPath),
    type,
    id,
    title: readString(data.title),
    description: readString(data.description),
    date: readString(data.date),
    status,
    domainStatus,
    sources: readSources(data.sources),
    generated: readStamp(data.generated),
    verified: readStampList(data.verified),
    frontmatter: data,
    body: parsed.body,
    raw: text,
    refs: findIdReferences(text),
    problems,
  };
}

/** True when the concept declares OKF provenance marking it machine-written (spec §1 principle 4). */
export function isDerived(concept: ParsedConcept): boolean {
  return concept.generated !== null;
}

/** OKF trust tiers (§5.3): a `human:` verifier outranks a machine one. */
export function trustTier(
  concept: ParsedConcept,
): "unverified" | "machine-confirmed" | "human-reviewed" {
  if (concept.verified.length === 0) return "unverified";
  return concept.verified.some((stamp) => stamp.by.startsWith("human:"))
    ? "human-reviewed"
    : "machine-confirmed";
}

function checkDirectory(relPath: string, type: ConceptType, problems: ConceptProblem[]): void {
  const dir = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  const expectedDir = TYPE_DIRECTORIES[type];

  if (expectedDir !== undefined) {
    if (dir !== expectedDir) {
      problems.push({
        kind: "type-mismatched-directory",
        message: `\`type: ${type}\` belongs in ${expectedDir}/, not ${dir === "" ? "the bundle root" : `${dir}/`}`,
      });
    }
    return;
  }

  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const expectedType = ROOT_CONCEPT_FILES[base];
  if (dir === "" && expectedType !== undefined && expectedType !== type) {
    problems.push({
      kind: "type-mismatched-directory",
      message: `${base} must declare \`type: ${expectedType}\``,
    });
  }
}

function checkId(
  relPath: string,
  type: ConceptType,
  id: string | null,
  problems: ConceptProblem[],
): void {
  const prefix = ID_BEARING_TYPES[type];
  if (prefix === undefined) return;

  if (!id) {
    problems.push({ kind: "id-missing", message: `\`type: ${type}\` requires an \`id\`` });
    return;
  }
  const parsedId = parseId(id);
  if (!parsedId || parsedId.prefix !== prefix) {
    problems.push({
      kind: "id-malformed",
      message: `\`id: ${id}\` is not a ${prefix}-### identifier`,
    });
    return;
  }

  // The filename carries the id verbatim (spec §4) so OKF's concept id — the
  // path — is self-describing. Decisions keep a slug suffix; everything else is
  // the bare id.
  const base = relPath.slice(relPath.lastIndexOf("/") + 1).replace(/\.md$/, "");
  const matches = type === "Decision" ? base === id || base.startsWith(`${id}-`) : base === id;
  if (!matches) {
    problems.push({
      kind: "id-filename-mismatch",
      message: `\`id: ${id}\` does not match the filename ${base}.md`,
    });
  }
}

function readStatus(value: unknown, problems: ConceptProblem[]): OkfStatus {
  const raw = readString(value);
  if (raw === null) return "stable";
  if ((OKF_STATUSES as readonly string[]).includes(raw)) return raw as OkfStatus;
  problems.push({
    kind: "status-invalid",
    message: `\`status: ${raw}\` is not an OKF lifecycle value (${OKF_STATUSES.join(" | ")})`,
  });
  return "stable";
}

function readDomainStatus(
  type: string | null,
  data: Record<string, unknown>,
  problems: ConceptProblem[],
): { field: string; value: string } | null {
  if (!type || !isConceptType(type)) return null;
  const spec = DOMAIN_STATUS_FIELDS[type];
  if (spec === undefined) return null;

  const raw = readString(data[spec.field]);
  if (raw === null) {
    problems.push({
      kind: "domain-status-invalid",
      message: `\`type: ${type}\` requires \`${spec.field}\``,
    });
    return null;
  }
  if (!spec.values.includes(raw)) {
    problems.push({
      kind: "domain-status-invalid",
      message: `\`${spec.field}: ${raw}\` is not one of ${spec.values.join(" | ")}`,
    });
  }
  return { field: spec.field, value: raw };
}

function readSources(value: unknown): ConceptSource[] {
  if (!Array.isArray(value)) return [];
  const sources: ConceptSource[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const resource = readString((entry as Record<string, unknown>).resource);
    if (resource === null) continue;
    const title = readString((entry as Record<string, unknown>).title);
    const id = readString((entry as Record<string, unknown>).id);
    sources.push({ resource, ...(title !== null && { title }), ...(id !== null && { id }) });
  }
  return sources;
}

function readStamp(value: unknown): ActorStamp | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const by = readString((value as Record<string, unknown>).by);
  if (by === null) return null;
  return { by, at: readString((value as Record<string, unknown>).at) };
}

/** OKF §5.2: a bare `verified` mapping MUST be read as a one-element list. */
function readStampList(value: unknown): ActorStamp[] {
  if (Array.isArray(value))
    return value.map(readStamp).filter((stamp): stamp is ActorStamp => stamp !== null);
  const single = readStamp(value);
  return single ? [single] : [];
}

function readString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // A bare `date: 2026-07-18` parses as a Date; the record's dates are days.
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return null;
}
