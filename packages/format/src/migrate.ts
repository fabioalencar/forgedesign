// v0.1 → v0.2 migration (spec/format.md §8, "Migrating from v0.1"). Planning is
// pure: it takes the v0.1 sources as text and returns the files a v0.2 bundle
// should contain, so the whole shape is testable without a filesystem. The CLI
// owns reading, writing, skipping what exists, and the supersession report.
//
// Two things move at once (DDR-060): ledger rows become one concept file each,
// and the whole record moves down into `design/`. Tasks are the exception —
// `todos.md` stays a single sectioned ledger and only gains frontmatter.

import { BUNDLE_DIR } from "./bundle.js";
import { buildBundleIndex } from "./bundle-index.js";
import { type ConceptType, parseConcept, ROOT_CONCEPT_FILES } from "./concepts.js";
import { parseDdrFilename, parseDecision } from "./decisions.js";
import { parseDerivedMarker } from "./derived.js";
import { splitStatusLink } from "./enums.js";
import { withFrontmatter } from "./frontmatter.js";
import { allEntries, type LedgerEntry, parseLedger } from "./ledger.js";

export interface V01Decision {
  filename: string;
  text: string;
}

/** The v0.1 files a migration reads, each as raw text. All optional. */
export interface V01Scenario {
  /** the legacy `scenarios/<slug>.md` filename stem */
  slug: string;
  text: string;
}

export interface V01Sources {
  brief?: string;
  todos?: string;
  glossary?: string;
  openQuestions?: string;
  feedbacks?: string;
  stakeholders?: string;
  userStories?: string;
  userRoles?: string;
  dataModel?: string;
  processFlows?: string;
  calendar?: string;
  design?: string;
  components?: string;
  featureLog?: string;
  decisions?: V01Decision[];
  scenarios?: V01Scenario[];
}

export interface MigratedFile {
  /** path relative to the repo root, e.g. "design/feedback/FEEDBACK-011.md" */
  relPath: string;
  text: string;
  /** the v0.1 file this content came from */
  source: string;
}

export interface MigrationPlan {
  files: MigratedFile[];
  /** v0.1 sources fully represented by the files above — what `--prune` removes */
  supersededSources: string[];
  /** content the migration could not place, reported rather than dropped silently */
  warnings: string[];
}

export interface MigrationOptions {
  /** bundle directory; defaults to `design` */
  recordRoot?: string;
}

/**
 * v0.1 file name → the whole-file v0.2 concept it becomes. `title` is the
 * fallback when the source carries no `# ` heading to take one from; it matches
 * what `forge init` scaffolds, so a migrated record and a fresh one do not
 * differ in a field neither project chose. Without it the title falls back to
 * the concept's own type, which reads as `title: Task Ledger` under
 * `type: Task Ledger`.
 */
const WHOLE_FILE_CONCEPTS: Array<{
  key: keyof V01Sources;
  source: string;
  target: string;
  type: ConceptType;
  title?: string;
}> = [
  { key: "brief", source: "Brief.md", target: "brief.md", type: "Brief", title: "Brief" },
  { key: "todos", source: "Todos.md", target: "todos.md", type: "Task Ledger", title: "Todos" },
  { key: "dataModel", source: "DataModel.md", target: "data-model.md", type: "Data Model" },
  { key: "calendar", source: "Calendar.md", target: "calendar.md", type: "Calendar" },
  { key: "design", source: "Design.md", target: "design-system.md", type: "Design System" },
  {
    key: "components",
    source: "Components.md",
    target: "components.md",
    type: "Component Inventory",
  },
];

/** Ledger files whose rows each become one concept file. */
const LEDGER_CONCEPTS: Array<{
  key: keyof V01Sources;
  source: string;
  dir: string;
  type: ConceptType;
}> = [
  { key: "openQuestions", source: "OpenQuestions.md", dir: "questions", type: "Question" },
  { key: "feedbacks", source: "Feedbacks.md", dir: "feedback", type: "Feedback" },
  { key: "stakeholders", source: "Stakeholders.md", dir: "stakeholders", type: "Stakeholder" },
  { key: "userStories", source: "UserStories.md", dir: "stories", type: "Story" },
  { key: "userRoles", source: "UserRoles.md", dir: "roles", type: "Role" },
  { key: "processFlows", source: "ProcessFlows.md", dir: "flows", type: "Flow" },
];

export function planMigrationToV02(
  sources: V01Sources,
  options: MigrationOptions = {},
): MigrationPlan {
  const root = options.recordRoot ?? BUNDLE_DIR;
  const files: MigratedFile[] = [];
  const superseded: string[] = [];
  const warnings: string[] = [];

  const add = (relPath: string, text: string, source: string): void => {
    files.push({ relPath: `${root}/${relPath}`, text, source });
  };

  for (const { key, source, target, type, title } of WHOLE_FILE_CONCEPTS) {
    const text = sources[key];
    if (typeof text !== "string") continue;
    add(
      target,
      withFrontmatter({ type, title: titleOf(text, target, title) }, stripLeadingH1(text)),
      source,
    );
    superseded.push(source);
  }

  for (const { key, source, dir, type } of LEDGER_CONCEPTS) {
    const text = sources[key];
    if (typeof text !== "string") continue;
    const entries = allEntries(parseLedger(text, { checkbox: false }));
    let migrated = 0;
    for (const entry of entries) {
      if (!entry.id) {
        warnings.push(`${source}: skipped a row with no id — "${firstLineOf(entry)}"`);
        continue;
      }
      add(`${dir}/${entry.id}.md`, conceptFromEntry(type, entry), source);
      migrated++;
    }
    if (migrated > 0 || entries.length === 0) superseded.push(source);
  }

  if (typeof sources.glossary === "string") {
    const terms = migrateGlossary(sources.glossary, warnings);
    for (const term of terms) add(`glossary/${term.slug}.md`, term.text, "Glossary.md");
    if (terms.length > 0) superseded.push("Glossary.md");
  }

  if (typeof sources.featureLog === "string") {
    add("feature-log.md", migrateFeatureLog(sources.featureLog), "FeatureLog.md");
    superseded.push("FeatureLog.md");
  }

  // Saved scenarios become SCENARIO-### concepts (DDR-063). Their `scn-` ids
  // were storage keys, not record ids; the declaration snapshots they point at
  // are keyed by the old id and are left exactly where they are.
  const scenarios = sources.scenarios ?? [];
  scenarios.forEach((scenario, index) => {
    const id = `SCENARIO-${String(index + 1).padStart(3, "0")}`;
    const migrated = migrateScenario(id, scenario, warnings);
    if (migrated) add(`scenarios/${id}.md`, migrated, `scenarios/${scenario.slug}.md`);
  });
  if (scenarios.length > 0) superseded.push("scenarios/");

  for (const decision of sources.decisions ?? []) {
    const migrated = migrateDecision(decision, warnings);
    if (migrated) add(`decisions/${decision.filename}`, migrated, `decisions/${decision.filename}`);
  }
  if ((sources.decisions ?? []).length > 0) superseded.push("decisions/");

  // An index of nothing is not a record. With no v0.1 sources to migrate this
  // returns an empty plan, so the CLI writes nothing and does not fabricate a
  // project in a directory that never had one.
  if (files.length > 0) {
    // Built from the concepts just produced, through the same builder `forge
    // index` uses — so a migrated bundle's index is byte-identical to a
    // regenerated one and doctor sees no staleness (T-300).
    const concepts = files.map((file) =>
      parseConcept(file.relPath.slice(root.length + 1), file.text),
    );
    files.push({ relPath: `${root}/index.md`, text: buildBundleIndex(concepts), source: "(new)" });
  }

  return { files, supersededSources: superseded, warnings };
}

// --- ledger rows -----------------------------------------------------------

/**
 * One ledger row becomes one concept. Structured fields carry into frontmatter;
 * prose continuation lines become the body, because YAML is a poor home for
 * paragraphs and the body is what a human reads first.
 */
function conceptFromEntry(type: ConceptType, entry: LedgerEntry): string {
  const { fields } = entry;
  const prose = proseLines(entry);
  const frontmatter: Record<string, unknown> = { type, id: entry.id };

  let body = "";
  if (type === "Feedback") {
    const quote = unquote(fields.quote ?? "");
    frontmatter.title = quote || entry.title || undefined;
    frontmatter.date = entry.date ?? undefined;
    const disposition = splitStatusLink(fields.status ?? "");
    frontmatter.feedback_status = disposition.status || "pending";
    frontmatter.source = fields.source ?? undefined;
    frontmatter.from = fields.from ?? undefined;
    frontmatter.resolution = disposition.link ?? undefined;
    body = quote ? `> ${quote}\n` : "";
  } else if (type === "Question") {
    const question = prose[0] ?? entry.title;
    frontmatter.title = question || undefined;
    frontmatter.date = entry.date ?? undefined;
    const resolution = splitStatusLink(fields.status ?? "");
    frontmatter.question_status = resolution.status || "open";
    frontmatter.resolution = resolution.link ?? undefined;
    frontmatter.context = fields.context ?? undefined;
    body = paragraphs(prose.slice(1), fields.notes);
  } else {
    frontmatter.title = entry.title || undefined;
    frontmatter.date = entry.date ?? undefined;
    for (const [key, value] of Object.entries(fields)) {
      if (key === "notes") continue;
      frontmatter[key] = value;
    }
    body = paragraphs(prose, fields.notes);
  }

  return withFrontmatter(frontmatter, body);
}

/** Continuation lines that are prose rather than `key: value` fields. */
function proseLines(entry: LedgerEntry): string[] {
  return entry.lines
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^[A-Za-z][\w-]*:/.test(line));
}

function paragraphs(lines: string[], notes?: string): string {
  const parts = [...lines];
  if (notes) parts.push(notes);
  return parts.length > 0 ? `${parts.join("\n\n")}\n` : "";
}

// --- whole files -----------------------------------------------------------

const TERM_RE = /^-\s+\*\*(.+?)\*\*\s*[—–-]\s*(.*)$/;

function migrateGlossary(text: string, warnings: string[]): Array<{ slug: string; text: string }> {
  const terms: Array<{ slug: string; text: string }> = [];
  const seen = new Set<string>();

  for (const line of text.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const match = TERM_RE.exec(line.trimEnd());
    if (!match?.[1]) {
      warnings.push(`Glossary.md: could not read a term from "${line.trim()}"`);
      continue;
    }
    const term = match[1].trim();
    const definition = (match[2] ?? "").trim();
    let slug = slugify(term);
    if (slug === "") slug = `term-${terms.length + 1}`;
    while (seen.has(slug)) slug = `${slug}-2`;
    seen.add(slug);
    terms.push({
      slug,
      text: withFrontmatter({ type: "Term", title: term }, definition ? `${definition}\n` : ""),
    });
  }
  return terms;
}

/**
 * FeatureLog's HTML generation marker becomes OKF `generated` frontmatter, and
 * the marker line leaves the body — the fact now has exactly one home.
 */
function migrateFeatureLog(text: string): string {
  const lines = text.split("\n");
  const marker = parseDerivedMarker(lines[0] ?? "");
  const body = marker ? lines.slice(1).join("\n").replace(/^\n+/, "") : text;
  return withFrontmatter(
    {
      type: "Feature Log",
      generated: marker ? { by: marker.generator } : undefined,
      freeze: marker?.ref,
    },
    stripLeadingH1(body),
  );
}

/**
 * A decision's `- **Status**:` header block becomes frontmatter. The block and
 * the H1 leave the body: restating them would give one fact two homes, and the
 * title already lives in frontmatter.
 *
 * This rewrites every accepted decision, which is the one migration step that
 * touches files doctor treats as immutable — the migration commit is the new
 * baseline for that check.
 */
function migrateDecision(decision: V01Decision, warnings: string[]): string | null {
  const parsed = parseDecision(decision.text);
  const fromFilename = parseDdrFilename(decision.filename);
  const id = parsed.id ?? fromFilename?.id ?? null;
  if (!id) {
    warnings.push(
      `decisions/${decision.filename}: no DDR id in its heading or filename — left as is`,
    );
    return null;
  }
  // DDR-000 is the template, not a decision: its Status line lists the enum
  // rather than choosing from it, so it migrates as a draft without complaint.
  // Doctor exempts the same id.
  const isTemplate = id === "DDR-000";
  if (!parsed.status && !isTemplate) {
    warnings.push(
      `decisions/${decision.filename}: unreadable Status "${parsed.statusRaw ?? "(none)"}" — migrated as draft`,
    );
  }

  const bodyStart = decision.text.split("\n").findIndex((line) => line.startsWith("## "));
  const body =
    bodyStart === -1 ? "" : `${decision.text.split("\n").slice(bodyStart).join("\n").trimEnd()}\n`;

  return withFrontmatter(
    {
      type: "Decision",
      id,
      title: parsed.title || undefined,
      // The nuance an author wrote after the status word ("refines DDR-055…")
      // has nowhere to go once the Status block leaves the body, and it is the
      // sentence that explains why the enum alone is not the whole answer.
      // `description` is where the index generator and the renderer's list
      // views read from, which is exactly where that sentence is wanted.
      description: parsed.status?.qualifier ?? undefined,
      date: parsed.date ?? undefined,
      decision_status: parsed.status?.base ?? "draft",
      superseded_by: parsed.status?.supersededBy ?? undefined,
      context_source: parsed.contextSource ?? undefined,
    },
    body,
  );
}

/**
 * A legacy scenario file into a concept. Its frontmatter is a hand-rolled YAML
 * subset, so this reads the handful of scalar keys the old serializer wrote
 * rather than pretending it was ever real YAML.
 */
function migrateScenario(id: string, scenario: V01Scenario, warnings: string[]): string | null {
  const match = scenario.text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    warnings.push(`scenarios/${scenario.slug}.md: no frontmatter block — left as is`);
    return null;
  }
  const scalars: Record<string, string> = {};
  const controls: Record<string, string> = {};
  let inControls = false;
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const top = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (top) {
      inControls = top[1] === "controls";
      if (!inControls && top[2]) scalars[top[1] as string] = top[2].trim();
      continue;
    }
    const entry = inControls ? line.match(/^\s+([\w.-]+):\s*(.*)$/) : null;
    if (entry) controls[entry[1] as string] = (entry[2] ?? "").trim();
  }

  const version = Number(scalars.version ?? "1");
  return withFrontmatter(
    {
      type: "Scenario",
      id,
      title: scalars.title ?? scenario.slug,
      version: Number.isInteger(version) && version > 0 ? version : 1,
      actor: scalars.actor,
      role: scalars.role,
      route: scalars.route,
      dataset: scalars.dataset,
      viewport: scalars.viewport,
      controls: Object.keys(controls).length > 0 ? controls : undefined,
      declarations: scalars.declarations,
      // The old `scn-` id was a storage key, kept so a pin or a declaration
      // snapshot naming it can still be traced back.
      legacy_id: scalars.id,
    },
    `${(match[2] ?? "").trim()}\n`,
  );
}

// --- small helpers ---------------------------------------------------------

function stripLeadingH1(text: string): string {
  const lines = text.split("\n");
  if (!(lines[0] ?? "").startsWith("# ")) return text;
  return lines.slice(1).join("\n").replace(/^\n+/, "");
}

function titleOf(text: string, fallbackFile: string, fallbackTitle?: string): string {
  const first = text.split("\n")[0] ?? "";
  if (first.startsWith("# ")) return first.slice(2).trim();
  if (fallbackTitle) return fallbackTitle;
  const type = ROOT_CONCEPT_FILES[fallbackFile];
  return type ?? fallbackFile;
}

function firstLineOf(entry: LedgerEntry): string {
  return (entry.lines[0] ?? "").trim();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^"(.*)"$/.exec(trimmed) ?? /^'(.*)'$/.exec(trimmed);
  return quoted?.[1] ?? trimmed;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
