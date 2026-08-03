// Emitting the scenario runtime bundle (DDR-063).
//
// The markdown concepts are the source; this is the derived machine form the
// ~1 kB runtime reads inside a frozen build. It is written into the build
// output alongside overlay injection, never into the record — a generated file
// in the bundle would be a second home for a fact the concepts already own.

import { promises as fs } from "node:fs";
import path from "node:path";
import { type ResolvedScenario, resolveScenario, scanBundle } from "@forgedesign/format";
import { SCENARIO_BUNDLE_FILE } from "@forgedesign/scenarios";
import { bundleRootOf } from "./bundle-index.js";
import { resolveDatasetReference } from "./datasets.js";

export { SCENARIO_BUNDLE_FILE };

export interface EmitScenariosResult {
  /** absolute path written, or null when there is nothing to emit */
  path: string | null;
  count: number;
  /** per-scenario problems worth showing at freeze time rather than swallowing */
  warnings: string[];
}

/**
 * Resolves every scenario in the record and writes the runtime bundle into
 * `outDir`. Seed data is inlined from the referenced dataset so the runtime
 * needs one fetch and no knowledge of where datasets live.
 */
export async function emitScenarioBundle(
  root: string,
  outDir: string,
): Promise<EmitScenariosResult> {
  const recordRoot = await bundleRootOf(root);
  if (recordRoot === null) return { path: null, count: 0, warnings: [] };

  const bundle = await scanBundle(root, { recordRoot });
  const scenarioConcepts = bundle.concepts.filter((concept) => concept.type === "Scenario");
  if (scenarioConcepts.length === 0) return { path: null, count: 0, warnings: [] };

  const roles = bundle.concepts.filter((concept) => concept.type === "Role");
  const warnings: string[] = [];
  const scenarios = [];

  for (const concept of scenarioConcepts) {
    const resolved: ResolvedScenario = resolveScenario(concept, roles);
    for (const problem of resolved.problems) warnings.push(`${resolved.id}: ${problem}`);
    scenarios.push({
      id: resolved.id,
      title: resolved.title,
      role: resolved.role,
      permissions: resolved.permissions,
      flags: resolved.flags,
      routes: resolved.routes,
      dataset: resolved.dataset,
      route: resolved.route,
      flow: resolved.flow,
      data: await seedDataFor(root, resolved, warnings),
    });
  }

  const target = path.join(outDir, SCENARIO_BUNDLE_FILE);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(target, `${JSON.stringify({ scenarios }, null, 2)}\n`, "utf8");
  return { path: target, count: scenarios.length, warnings };
}

/**
 * A scenario's seed data, read from the dataset it names. A missing dataset is
 * reported and the scenario ships with none — a stakeholder seeing an empty
 * list is recoverable, a freeze that fails late because of a stale reference is
 * not.
 */
async function seedDataFor(
  root: string,
  resolved: ResolvedScenario,
  warnings: string[],
): Promise<Record<string, unknown>> {
  if (resolved.dataset === null) return {};
  try {
    const dataset = await resolveDatasetReference(resolved.dataset, root);
    if (dataset === null) {
      warnings.push(`${resolved.id}: dataset "${resolved.dataset}" is not in this record`);
      return {};
    }
    return dataset.records;
  } catch {
    warnings.push(`${resolved.id}: dataset "${resolved.dataset}" could not be read`);
    return {};
  }
}
