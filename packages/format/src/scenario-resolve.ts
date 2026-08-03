// Resolving a scenario into what the prototype actually runs under (DDR-063).
//
// A scenario names a role and the role concept carries what that role can do,
// so the permission set has to be composed rather than read off one file. That
// composition lives here — one implementation the runtime emitter, the
// dashboard, and Cloud's role switcher all share, because three consumers
// computing "effective permissions" separately is three chances to disagree.
//
// Creator decision 2026-07-27: the scenario's list is **additive** to its
// role's, and a `-` prefix removes one. One field expresses both directions, so
// a degraded state ("a manager who cannot approve") is reviewable without
// restating the whole role — which is exactly the state design review exists to
// catch.

import type { ParsedConcept } from "./concepts.js";

export interface FlowStep {
  id: string;
  label: string;
  route: string | null;
}

export interface RouteRules {
  hidden: string[];
  redirect: Record<string, string>;
}

export interface ResolvedScenario {
  id: string;
  title: string;
  /** the ROLE-### this scenario runs as, when it names one */
  role: string | null;
  /** effective permissions after composing the role's with the scenario's */
  permissions: string[];
  flags: Record<string, string | boolean>;
  routes: RouteRules;
  dataset: string | null;
  route: string | null;
  viewport: string | null;
  flow: FlowStep[];
  /** things a consumer should surface rather than silently paper over */
  problems: string[];
}

/** `- s1 · Open pending orders · /orders?f=pending` under a `## Flow` heading. */
const FLOW_STEP_RE = /^-\s+(\S+)\s+·\s+([^·]+?)(?:\s+·\s+(\S+))?\s*$/;

export function resolveScenario(
  scenario: ParsedConcept,
  roles: readonly ParsedConcept[],
): ResolvedScenario {
  const problems: string[] = [];
  const fm = scenario.frontmatter;
  const roleId = readString(fm.role);

  const roleConcept = roleId === null ? null : (roles.find((r) => r.id === roleId) ?? null);
  if (roleId !== null && roleConcept === null) {
    problems.push(`role ${roleId} is not a role in this record`);
  }

  return {
    id: scenario.id ?? scenario.conceptId,
    title: scenario.title ?? scenario.id ?? scenario.conceptId,
    role: roleId,
    permissions: composePermissions(
      readList(roleConcept?.frontmatter.permissions),
      readList(fm.permissions),
      problems,
    ),
    flags: readFlags(fm.flags),
    routes: readRoutes(fm.routes),
    dataset: readString(fm.dataset),
    route: readString(fm.route),
    viewport: readString(fm.viewport),
    flow: readFlow(scenario.body),
    problems,
  };
}

/**
 * The role's grants plus the scenario's, minus anything the scenario prefixed
 * with `-`. Removing a permission the role never granted is reported: it
 * usually means the role changed underneath the scenario, and silently doing
 * nothing would hide that.
 */
export function composePermissions(
  rolePermissions: readonly string[],
  scenarioPermissions: readonly string[],
  problems: string[] = [],
): string[] {
  const effective = new Set(rolePermissions);
  for (const entry of scenarioPermissions) {
    if (!entry.startsWith("-")) {
      effective.add(entry);
      continue;
    }
    const removed = entry.slice(1).trim();
    if (removed === "") continue;
    if (!effective.has(removed)) {
      problems.push(`removes "${removed}", which its role does not grant`);
    }
    effective.delete(removed);
  }
  return [...effective].sort();
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string").map((s) => s.trim());
}

function readFlags(value: unknown): Record<string, string | boolean> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const flags: Record<string, string | boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "boolean" || typeof raw === "string") flags[key] = raw;
  }
  return flags;
}

function readRoutes(value: unknown): RouteRules {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { hidden: [], redirect: {} };
  }
  const routes = value as Record<string, unknown>;
  const redirect: Record<string, string> = {};
  if (typeof routes.redirect === "object" && routes.redirect !== null) {
    for (const [from, to] of Object.entries(routes.redirect as Record<string, unknown>)) {
      if (typeof to === "string") redirect[from] = to;
    }
  }
  return { hidden: readList(routes.hidden), redirect };
}

/** Steps from the body's `## Flow` section; a scenario without one has none. */
function readFlow(body: string): FlowStep[] {
  const steps: FlowStep[] = [];
  let inFlow = false;
  for (const line of body.split("\n")) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      inFlow = heading[1]?.trim().toLowerCase() === "flow";
      continue;
    }
    if (!inFlow) continue;
    const match = FLOW_STEP_RE.exec(line.trim());
    if (match?.[1] && match[2]) {
      steps.push({ id: match[1], label: match[2].trim(), route: match[3] ?? null });
    }
  }
  return steps;
}
