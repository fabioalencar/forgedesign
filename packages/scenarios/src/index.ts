// The scenario runtime (DDR-063). Ships inside a frozen build and answers the
// questions a prototype asks about who is reviewing it: what can they do, which
// flags are on, what data is seeded, and where may they go.
//
// The record is the source; this reads the JSON emitted from it at build time.
// It is deliberately tiny and dependency-free because it runs in a stakeholder's
// browser inside a build that has no Forge tooling in it at all — and because
// the overlay it sits beside has the same constraint.

export interface ScenarioData {
  id: string;
  title: string;
  role: string | null;
  permissions: string[];
  flags: Record<string, string | boolean>;
  routes: { hidden: string[]; redirect: Record<string, string> };
  dataset: string | null;
  route: string | null;
  flow: Array<{ id: string; label: string; route: string | null }>;
  /** seed data, keyed by collection */
  data: Record<string, unknown>;
}

export interface ScenarioBundle {
  scenarios: ScenarioData[];
}

export interface ScenarioRuntime {
  /** the active scenario, or null when none was selected or the id is unknown */
  readonly active: ScenarioData | null;
  /** every scenario in the build, for a selector */
  readonly all: ScenarioData[];
  can(permission: string): boolean;
  flag(name: string): string | boolean | undefined;
  data<T = unknown>(collection: string): T | undefined;
  /**
   * Where this route should actually go: the same path when it is allowed, a
   * redirect target when one is declared, or null when the scenario hides it.
   * A guard calls this instead of reimplementing the matching.
   */
  resolveRoute(path: string): string | null;
}

/**
 * The file the freeze emits and everything in the browser reads. It lives here
 * rather than in the emitter that writes it, because the readers — a prototype's
 * own runtime and the comment overlay's scenario bar — need the name too, and a
 * filename agreed by convention across three packages is a filename that will
 * eventually disagree.
 */
export const SCENARIO_BUNDLE_FILE = "forge-scenarios.json";

const QUERY_PARAM = "scenario";

/**
 * Matches the glob shapes route rules use: `*` within a segment, `**` across
 * segments. Anything else is compared literally, so a plain path stays a plain
 * path and cannot accidentally behave like a pattern.
 */
function matchesPattern(pattern: string, path: string): boolean {
  if (!pattern.includes("*")) return pattern === path;
  // Split on the wildcards rather than substituting a placeholder: a sentinel
  // character can survive into the pattern and change what it matches.
  const source = pattern
    .split("**")
    .map((across) =>
      across
        .split("*")
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`).test(path);
}

/** The runtime over an explicit bundle and scenario id — the testable core. */
export function createScenarioRuntime(
  bundle: ScenarioBundle,
  activeId: string | null,
): ScenarioRuntime {
  const all = bundle.scenarios ?? [];
  const active = activeId === null ? null : (all.find((s) => s.id === activeId) ?? null);

  return {
    active,
    all,
    can: (permission) => active?.permissions.includes(permission) ?? false,
    flag: (name) => active?.flags[name],
    data: <T>(collection: string) => active?.data?.[collection] as T | undefined,
    resolveRoute: (path) => {
      if (!active) return path;
      const redirect = active.routes.redirect[path];
      if (redirect !== undefined) return redirect;
      const hidden = active.routes.hidden.some((pattern) => matchesPattern(pattern, path));
      return hidden ? null : path;
    },
  };
}

/** The scenario id in `?scenario=`, or null. */
export function activeScenarioId(
  search: string = globalThis.location?.search ?? "",
): string | null {
  const value = new URLSearchParams(search).get(QUERY_PARAM);
  return value !== null && value !== "" ? value : null;
}

/**
 * The runtime for a build: reads the emitted bundle and the query parameter.
 * With no scenario selected every permission is denied and every route allowed,
 * so an unscoped visit sees the prototype's own defaults rather than a
 * half-applied role.
 */
export function scenarioRuntimeFrom(bundle: ScenarioBundle, search?: string): ScenarioRuntime {
  return createScenarioRuntime(bundle, activeScenarioId(search));
}
