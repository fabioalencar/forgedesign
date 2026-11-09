// Change entries (spec §5, DDR-176): `design/changes/CHANGE-###.md`.
//
// An entry is what a stakeholder is told changed, or is coming, in the
// creator's words. Its frontmatter carries the facts a changelog page filters
// by — the routes it touches, who asked, the tickets it tracks, and the ids
// behind it — and its body says what a reader will notice.
//
// This reads those fields leniently and reports what it could not read, the
// way `parseConcept` does: doctor turns the problems into findings, and every
// other reader still gets what was there. Nothing here decides which version an
// entry shipped in; that is derived from the tags at publish.

import type { ParsedConcept } from "./concepts.js";
import { type ChangeStatus, isChangeStatus } from "./enums.js";
import { ID_REFERENCE_RE } from "./ids.js";

export interface ChangeView {
  id: string;
  title: string;
  status: ChangeStatus | null;
  /** root-relative routes, as written */
  routes: string[];
  /** the display name the creator chose to show, if any */
  requestedBy: string | null;
  /** ticket URLs */
  links: string[];
  /** the tasks, feedback and decisions behind the entry */
  refs: string[];
}

export interface ChangeFieldProblem {
  field: "routes" | "links" | "refs" | "requested_by";
  message: string;
}

/** A field that is a list, or one value the author did not bracket. */
function readList(value: unknown): { items: string[]; malformed: boolean } {
  if (value === undefined || value === null) return { items: [], malformed: false };
  const raw = Array.isArray(value) ? value : [value];
  const items: string[] = [];
  let malformed = false;
  for (const item of raw) {
    if (typeof item === "string" && item.trim() !== "") items.push(item.trim());
    else malformed = true;
  }
  return { items, malformed };
}

const isHttpUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
};

const EXACT_ID_RE = new RegExp(`^${ID_REFERENCE_RE.source}$`);

/** The entry's fields, and what in them is not the shape the spec gives. */
export function readChange(concept: ParsedConcept): {
  change: ChangeView;
  problems: ChangeFieldProblem[];
} {
  const data = concept.frontmatter;
  const problems: ChangeFieldProblem[] = [];

  const routes = readList(data.routes);
  if (routes.malformed) problems.push({ field: "routes", message: "`routes` must list routes" });
  for (const route of routes.items) {
    if (!route.startsWith("/")) {
      problems.push({
        field: "routes",
        message: `\`${route}\` is not a root-relative route — write it as the build serves it, e.g. \`/register\``,
      });
    }
  }

  const links = readList(data.links);
  if (links.malformed) problems.push({ field: "links", message: "`links` must list URLs" });
  for (const link of links.items) {
    if (!isHttpUrl(link)) {
      problems.push({ field: "links", message: `\`${link}\` is not an http(s) URL` });
    }
  }

  const refs = readList(data.refs);
  if (refs.malformed) problems.push({ field: "refs", message: "`refs` must list ids" });
  for (const ref of refs.items) {
    if (!EXACT_ID_RE.test(ref)) {
      problems.push({
        field: "refs",
        message: `\`${ref}\` is not a record id (TASK-###, FEEDBACK-###, DDR-###, …)`,
      });
    }
  }

  let requestedBy: string | null = null;
  if (data.requested_by !== undefined && data.requested_by !== null) {
    if (typeof data.requested_by === "string" && data.requested_by.trim() !== "") {
      requestedBy = data.requested_by.trim();
    } else {
      problems.push({ field: "requested_by", message: "`requested_by` must be a name" });
    }
  }

  const status = concept.domainStatus?.value ?? null;
  return {
    change: {
      id: concept.id ?? concept.conceptId,
      title: concept.title ?? concept.id ?? concept.conceptId,
      status: status !== null && isChangeStatus(status) ? status : null,
      routes: routes.items,
      requestedBy,
      links: links.items,
      refs: refs.items,
    },
    problems,
  };
}
