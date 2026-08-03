// Screen-first scenarios (DDR-037/041): capture a working preview's state
// as a Draft, then promote it to a versioned, reviewable Saved scenario.
// Lifecycle: Observed (in-memory dashboard state, no file) → Draft
// (`.forge/scenarios/<id>.md`, propose-only) → Saved → Pinned (a Version
// Snapshot citing the scenario at a version plus a Git commit — no separate
// file; see DDR-045).
//
// Under v0.2 a Saved scenario is a record concept at
// `design/scenarios/SCENARIO-###.md` (DDR-063); a repo without a bundle keeps
// the legacy `scenarios/<slug>.md`. Drafts are unchanged either way, because
// staging is not the record.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  nextId,
  type ParsedConcept,
  parseConcept,
  scanBundle,
  withFrontmatter,
} from "@forgedesign/format";
import { bundleRootOf, writeBundleIndex } from "./bundle-index.js";

const BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford, lowercase
const SCENARIO_ID_RE = /^scn-[0-9a-hjkmnp-tv-z]{8}$/;

export type ScenarioControlValue = string | boolean;

export interface ScenarioFrontmatter {
  type: "scenario";
  id: string;
  version: number;
  title: string;
  actor?: string;
  role?: string;
  route?: string;
  dataset?: string;
  viewport?: string;
  controls: Record<string, ScenarioControlValue>;
  declarations?: string;
}

export interface Scenario {
  frontmatter: ScenarioFrontmatter;
  purpose: string;
  expectedOutcome?: string;
}

export interface DraftScenario extends Scenario {
  id: string;
  createdAt: string;
}

export interface SavedScenario extends Scenario {
  slug: string;
  path: string;
}

function draftsRoot(repoRoot: string): string {
  return path.join(repoRoot, ".forge", "scenarios");
}

function draftPath(repoRoot: string, id: string): string {
  if (!SCENARIO_ID_RE.test(id)) throw new Error("invalid scenario id");
  return path.join(draftsRoot(repoRoot), `${id}.md`);
}

function draftDeclarationsPath(repoRoot: string, id: string): string {
  if (!SCENARIO_ID_RE.test(id)) throw new Error("invalid scenario id");
  return path.join(draftsRoot(repoRoot), `${id}.decls.json`);
}

function savedRoot(repoRoot: string): string {
  return path.join(repoRoot, "scenarios");
}

function declsRoot(repoRoot: string): string {
  return path.join(repoRoot, ".forge", "scenario-decls");
}

function declarationSnapshotPath(id: string, version: number): string {
  return `.forge/scenario-decls/${id}@${version}.json`;
}

export function generateScenarioId(): string {
  const bytes = randomBytes(5); // 40 bits → 8 base32 chars
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = BASE32_ALPHABET[Number(bits & 0x1fn)] + out;
    bits >>= 5n;
  }
  return `scn-${out}`;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "scenario"
  );
}

function isSafeBareValue(value: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(value);
}

function serializeControlValue(value: ScenarioControlValue): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  return isSafeBareValue(value) ? value : JSON.stringify(value);
}

function parseControlValue(raw: string): ScenarioControlValue {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

const EXPECTED_OUTCOME_RE = /^\*\*Expected outcome:\*\*\s?/m;

export function serializeScenario(scenario: Scenario): string {
  const fm = scenario.frontmatter;
  const lines = [
    "---",
    "type: scenario",
    `id: ${fm.id}`,
    `version: ${fm.version}`,
    `title: ${fm.title}`,
  ];
  if (fm.actor) lines.push(`actor: ${fm.actor}`);
  if (fm.role) lines.push(`role: ${fm.role}`);
  if (fm.route) lines.push(`route: ${fm.route}`);
  if (fm.dataset) lines.push(`dataset: ${fm.dataset}`);
  if (fm.viewport) lines.push(`viewport: ${fm.viewport}`);
  const controlIds = Object.keys(fm.controls);
  if (controlIds.length > 0) {
    lines.push("controls:");
    for (const id of controlIds) {
      lines.push(`  ${id}: ${serializeControlValue(fm.controls[id]!)}`);
    }
  }
  if (fm.declarations) lines.push(`declarations: ${fm.declarations}`);
  lines.push("---");
  const body = [scenario.purpose.trim()];
  if (scenario.expectedOutcome?.trim()) {
    body.push("", `**Expected outcome:** ${scenario.expectedOutcome.trim()}`);
  }
  return `${lines.join("\n")}\n${body.join("\n")}\n`;
}

export function parseScenario(source: string): Scenario | null {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const frontmatter = match[1] ?? "";
  const body = (match[2] ?? "").trim();
  const fmLines = frontmatter.split(/\r?\n/);

  const scalars: Record<string, string> = {};
  const controls: Record<string, ScenarioControlValue> = {};
  let inControls = false;
  for (const line of fmLines) {
    const topLevel = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (topLevel) {
      inControls = topLevel[1] === "controls";
      if (!inControls && topLevel[2]) scalars[topLevel[1]!] = topLevel[2].trim();
      continue;
    }
    if (inControls) {
      const entry = line.match(/^\s+([\w.-]+):\s*(.*)$/);
      if (entry) controls[entry[1]!] = parseControlValue(entry[2] ?? "");
    }
  }

  if (scalars.type !== "scenario" || !scalars.id || !scalars.title) return null;
  const version = Number(scalars.version ?? "1");
  if (!Number.isInteger(version) || version < 1) return null;

  const outcomeMatch = body.match(EXPECTED_OUTCOME_RE);
  const purpose = outcomeMatch ? body.slice(0, outcomeMatch.index).trim() : body;
  const expectedOutcome = outcomeMatch
    ? body.slice(outcomeMatch.index! + outcomeMatch[0].length).trim()
    : undefined;

  return {
    frontmatter: {
      type: "scenario",
      id: scalars.id,
      version,
      title: scalars.title,
      actor: scalars.actor,
      role: scalars.role,
      route: scalars.route,
      dataset: scalars.dataset,
      viewport: scalars.viewport,
      controls,
      declarations: scalars.declarations,
    },
    purpose,
    expectedOutcome,
  };
}

export interface CaptureScenarioOptions {
  cwd?: string;
  title: string;
  actor?: string;
  role?: string;
  route?: string;
  /** "ds-<id>@<version>" (DDR-041/046) — which dataset this scenario replays against, if any. */
  dataset?: string;
  viewport?: string;
  controls: Record<string, ScenarioControlValue>;
  purpose: string;
  expectedOutcome?: string;
  /**
   * The live control schema (ids/kinds/labels/options — no values) at capture
   * time. The bridge session that captured this Draft may not still be open
   * when it's later Saved, so this is recorded now and carried alongside the
   * draft rather than re-requested at Save time.
   */
  declarations?: unknown[];
}

/** Observed → Draft: stage the captured setup. Never touches `scenarios/`. */
export async function createDraftScenario(options: CaptureScenarioOptions): Promise<DraftScenario> {
  const root = path.resolve(options.cwd ?? process.cwd());
  const id = generateScenarioId();
  const scenario: Scenario = {
    frontmatter: {
      type: "scenario",
      id,
      version: 1,
      title: options.title.trim(),
      actor: options.actor?.trim() || undefined,
      role: options.role?.trim() || undefined,
      route: options.route?.trim() || undefined,
      dataset: options.dataset?.trim() || undefined,
      viewport: options.viewport?.trim() || undefined,
      controls: options.controls,
    },
    purpose: options.purpose.trim(),
    expectedOutcome: options.expectedOutcome?.trim() || undefined,
  };
  await fs.mkdir(draftsRoot(root), { recursive: true });
  await fs.writeFile(draftPath(root, id), serializeScenario(scenario), "utf8");
  if (options.declarations) {
    await fs.writeFile(
      draftDeclarationsPath(root, id),
      `${JSON.stringify(options.declarations, null, 2)}\n`,
      "utf8",
    );
  }
  return { ...scenario, id, createdAt: new Date().toISOString() };
}

async function readDraftFile(root: string, id: string): Promise<Scenario> {
  const raw = await fs.readFile(draftPath(root, id), "utf8");
  const parsed = parseScenario(raw);
  if (!parsed) throw new Error(`draft scenario ${id} is malformed`);
  return parsed;
}

export async function readDraftScenario(id: string, cwd?: string): Promise<DraftScenario> {
  const root = path.resolve(cwd ?? process.cwd());
  const scenario = await readDraftFile(root, id);
  const stat = await fs.stat(draftPath(root, id));
  return { ...scenario, id, createdAt: stat.birthtime.toISOString() };
}

export async function listDraftScenarios(cwd?: string): Promise<DraftScenario[]> {
  const root = path.resolve(cwd ?? process.cwd());
  let entries: string[];
  try {
    entries = await fs.readdir(draftsRoot(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const drafts: DraftScenario[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -".md".length);
    if (!SCENARIO_ID_RE.test(id)) continue;
    drafts.push(await readDraftScenario(id, root));
  }
  return drafts.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function discardDraftScenario(id: string, cwd?: string): Promise<void> {
  const root = path.resolve(cwd ?? process.cwd());
  await fs.rm(draftPath(root, id), { force: true });
  await fs.rm(draftDeclarationsPath(root, id), { force: true });
}

async function uniqueSlug(root: string, title: string): Promise<string> {
  const base = slugify(title);
  let candidate = base;
  let suffix = 2;
  while (true) {
    try {
      await fs.access(path.join(savedRoot(root), `${candidate}.md`));
      candidate = `${base}-${suffix}`;
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}

/**
 * Draft → Saved: commits the file into `scenarios/` and writes its
 * declaration snapshot. `declarationSnapshot` defaults to whatever was
 * captured alongside the draft at Observed time; pass it explicitly to
 * override (e.g. a fresher read from a still-open bridge session). Neither
 * source found means the snapshot is honestly empty, not guessed.
 */
export async function saveScenario(
  draftId: string,
  declarationSnapshot?: unknown[],
  cwd?: string,
): Promise<SavedScenario> {
  const root = path.resolve(cwd ?? process.cwd());
  const draft = await readDraftFile(root, draftId);
  const slug = await uniqueSlug(root, draft.frontmatter.title);
  const declarations = declarationSnapshotPath(draft.frontmatter.id, draft.frontmatter.version);
  const scenario: Scenario = {
    ...draft,
    frontmatter: { ...draft.frontmatter, declarations },
  };

  let snapshot = declarationSnapshot;
  if (snapshot === undefined) {
    try {
      snapshot = JSON.parse(
        await fs.readFile(draftDeclarationsPath(root, draftId), "utf8"),
      ) as unknown[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      snapshot = [];
    }
  }

  const location = await savedScenarioLocation(root);
  await fs.mkdir(location.dir, { recursive: true });
  await fs.mkdir(declsRoot(root), { recursive: true });

  // In a record the filename carries the id, so the slug is the id; without one
  // the legacy title-derived slug still names the file.
  const stem = location.concept ? await nextScenarioId(root) : slug;
  const savedFilePath = path.join(location.dir, `${stem}.md`);
  await fs.writeFile(
    savedFilePath,
    location.concept ? scenarioConceptText(stem, scenario) : serializeScenario(scenario),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, declarations),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8",
  );
  await fs.rm(draftPath(root, draftId), { force: true });
  await fs.rm(draftDeclarationsPath(root, draftId), { force: true });

  const saved: SavedScenario = {
    ...scenario,
    frontmatter: { ...scenario.frontmatter, id: stem },
    slug: stem,
    path: path.join(location.relDir, `${stem}.md`),
  };
  if (location.concept) await writeBundleIndex(root);
  return saved;
}

/** Next `SCENARIO-###`, allocated across the concepts already in the bundle. */
async function nextScenarioId(root: string): Promise<string> {
  const recordRoot = await bundleRootOf(root);
  if (recordRoot === null) return "SCENARIO-001";
  const bundle = await scanBundle(root, { recordRoot });
  const existing = bundle.concepts.flatMap((c) => (c.type === "Scenario" && c.id ? [c.id] : []));
  return nextId(existing, "SCENARIO");
}

async function readSavedFile(root: string, slug: string): Promise<SavedScenario> {
  const location = await savedScenarioLocation(root);
  const filePath = path.join(location.dir, `${slug}.md`);
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = location.concept
    ? scenarioFromConcept(parseConcept(`scenarios/${slug}.md`, raw))
    : parseScenario(raw);
  if (!parsed) throw new Error(`saved scenario ${slug} is malformed`);
  return { ...parsed, slug, path: path.join(location.relDir, `${slug}.md`) };
}

export async function listSavedScenarios(cwd?: string): Promise<SavedScenario[]> {
  const root = path.resolve(cwd ?? process.cwd());
  const location = await savedScenarioLocation(root);
  let entries: string[];
  try {
    entries = await fs.readdir(location.dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const scenarios: SavedScenario[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    scenarios.push(await readSavedFile(root, entry.slice(0, -".md".length)));
  }
  return scenarios.sort((a, b) => a.frontmatter.title.localeCompare(b.frontmatter.title));
}

export async function getSavedScenario(slug: string, cwd?: string): Promise<SavedScenario | null> {
  const root = path.resolve(cwd ?? process.cwd());
  try {
    return await readSavedFile(root, slug);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface ScenarioEdit {
  controls?: Record<string, ScenarioControlValue>;
  route?: string;
  purpose?: string;
  expectedOutcome?: string;
}

/**
 * Bumps a Saved scenario to a new version rather than mutating it in place —
 * the previous version's file content stays in Git history and its
 * declaration snapshot is left untouched, so a Pin citing the old version
 * keeps working (DDR-045).
 */
export async function updateSavedScenario(
  slug: string,
  edit: ScenarioEdit,
  declarationSnapshot: unknown[],
  cwd?: string,
): Promise<SavedScenario> {
  const root = path.resolve(cwd ?? process.cwd());
  const current = await readSavedFile(root, slug);
  const version = current.frontmatter.version + 1;
  const declarations = declarationSnapshotPath(current.frontmatter.id, version);
  const next: Scenario = {
    frontmatter: {
      ...current.frontmatter,
      version,
      route: edit.route ?? current.frontmatter.route,
      controls: edit.controls ?? current.frontmatter.controls,
      declarations,
    },
    purpose: edit.purpose ?? current.purpose,
    expectedOutcome: edit.expectedOutcome ?? current.expectedOutcome,
  };
  await fs.mkdir(declsRoot(root), { recursive: true });
  await fs.writeFile(path.join(savedRoot(root), `${slug}.md`), serializeScenario(next), "utf8");
  await fs.writeFile(
    path.join(root, declarations),
    `${JSON.stringify(declarationSnapshot, null, 2)}\n`,
    "utf8",
  );
  return { ...next, slug, path: path.join("scenarios", `${slug}.md`) };
}

// --- v0.2: a Saved scenario is a record concept (DDR-063) ------------------
//
// Drafts stay where they are, with `scn-` ids under `.forge/` — staging isn't
// the record. Saving is what promotes one into the bundle, where it gets a
// `SCENARIO-###` id, real YAML frontmatter, and doctor's validation.

/** Where Saved scenarios live, and in which shape. */
export async function savedScenarioLocation(
  root: string,
): Promise<{ dir: string; relDir: string; concept: boolean }> {
  const recordRoot = await bundleRootOf(root);
  if (recordRoot === null) {
    return { dir: savedRoot(root), relDir: "scenarios", concept: false };
  }
  const relDir = path.join(recordRoot, "scenarios");
  return { dir: path.join(root, relDir), relDir, concept: true };
}

/** The merged frontmatter (DDR-063): capture fields plus the behavioural declaration. */
function scenarioConceptText(id: string, scenario: Scenario): string {
  const fm = scenario.frontmatter;
  const body = [scenario.purpose.trim()];
  if (scenario.expectedOutcome?.trim()) {
    body.push("", `**Expected outcome:** ${scenario.expectedOutcome.trim()}`);
  }
  return withFrontmatter(
    {
      type: "Scenario",
      id,
      title: fm.title,
      version: fm.version,
      actor: fm.actor,
      role: fm.role,
      route: fm.route,
      dataset: fm.dataset,
      viewport: fm.viewport,
      controls: Object.keys(fm.controls).length > 0 ? fm.controls : undefined,
      declarations: fm.declarations,
    },
    `${body.join("\n")}\n`,
  );
}

/** A concept back into the in-memory Scenario shape the dashboard already renders. */
export function scenarioFromConcept(concept: ParsedConcept): Scenario | null {
  if (concept.type !== "Scenario" || concept.id === null) return null;
  const fm = concept.frontmatter;
  const controls: Record<string, ScenarioControlValue> = {};
  if (typeof fm.controls === "object" && fm.controls !== null && !Array.isArray(fm.controls)) {
    for (const [key, value] of Object.entries(fm.controls as Record<string, unknown>)) {
      if (typeof value === "string" || typeof value === "boolean") controls[key] = value;
    }
  }
  const body = concept.body.trim();
  const outcomeMatch = body.match(EXPECTED_OUTCOME_RE);
  const purpose = outcomeMatch ? body.slice(0, outcomeMatch.index).trim() : body;
  const expectedOutcome = outcomeMatch
    ? body.slice((outcomeMatch.index ?? 0) + outcomeMatch[0].length).trim()
    : undefined;

  const str = (key: string): string | undefined =>
    typeof fm[key] === "string" && fm[key] !== "" ? (fm[key] as string) : undefined;

  return {
    frontmatter: {
      type: "scenario",
      id: concept.id,
      version: typeof fm.version === "number" ? fm.version : 1,
      title: concept.title ?? concept.id,
      actor: str("actor"),
      role: str("role"),
      route: str("route"),
      dataset: str("dataset"),
      viewport: str("viewport"),
      controls,
      declarations: str("declarations"),
    },
    purpose,
    expectedOutcome,
  };
}
