// Deterministic synthetic seed datasets (DDR-037/041/046): reusable,
// versioned, referentially-checked records separate from any one scenario.
// Committed records are replay truth — generation is provenance only.

import { promises as fs } from "node:fs";
import path from "node:path";

const BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford, lowercase
const MIN_ACKNOWLEDGMENT_LENGTH = 20;

export type DatasetFieldSpec =
  | { type: "id"; prefix: string }
  | { type: "name" }
  | { type: "email" }
  | { type: "sentence"; words?: number }
  | { type: "number"; min: number; max: number }
  | { type: "boolean" }
  | { type: "enum"; values: string[] }
  | { type: "date"; startDaysAgo: number; endDaysAgo: number }
  | { type: "ref"; entity: string; field: string };

export interface DatasetEntitySpec {
  name: string;
  count: number;
  fields: Record<string, DatasetFieldSpec>;
}

export interface DatasetRelationship {
  from: string; // "<entity>.<field>"
  to: string; // "<entity>.<field>"
}

export interface DatasetManifest {
  type: "dataset";
  id: string;
  version: number;
  title: string;
  entities: string[];
  relationships: DatasetRelationship[];
  provenance: "synthetic" | "imported";
  generator?: { name: string; version: string; seed: number };
  importedAcknowledgment?: string;
}

export interface Dataset {
  manifest: DatasetManifest;
  records: Record<string, unknown[]>;
  slug: string;
  dir: string;
}

function datasetsRoot(repoRoot: string): string {
  return path.join(repoRoot, "datasets");
}

function datasetDir(repoRoot: string, slug: string): string {
  return path.join(datasetsRoot(repoRoot), slug);
}

function manifestPath(repoRoot: string, slug: string): string {
  return path.join(datasetDir(repoRoot, slug), "dataset.md");
}

function recordsPath(repoRoot: string, slug: string, entity: string): string {
  return path.join(datasetDir(repoRoot, slug), "records", `${entity}.json`);
}

export function generateDatasetId(): string {
  const bytes = new Uint8Array(5); // 40 bits → 8 base32 chars
  const random = Math.random; // seed generation itself needs no determinism
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out = BASE32_ALPHABET[Number(bits & 0x1fn)] + out;
    bits >>= 5n;
  }
  return `ds-${out}`;
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "dataset"
  );
}

// --- Deterministic seeded generation -----------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  "Susan",
  "Marco",
  "Amara",
  "Devon",
  "Priya",
  "Lucas",
  "Noor",
  "Elena",
  "Kwame",
  "Ingrid",
  "Yuki",
  "Omar",
  "Fatima",
  "Liam",
  "Sofia",
  "Kenji",
];
const LAST_NAMES = [
  "Reyes",
  "Chen",
  "Okafor",
  "Silva",
  "Novak",
  "Patel",
  "Larsen",
  "Costa",
  "Haddad",
  "Berg",
  "Nakamura",
  "Osei",
  "Ferreira",
  "Kowalski",
  "Abara",
  "Lund",
];
const LOREM_WORDS = [
  "proposal",
  "review",
  "budget",
  "timeline",
  "stakeholder",
  "draft",
  "approval",
  "scope",
  "milestone",
  "risk",
  "clause",
  "vendor",
  "renewal",
  "signature",
  "amendment",
  "deadline",
];

function pick<T>(rng: () => number, values: readonly T[]): T {
  const value = values[Math.floor(rng() * values.length)];
  if (value === undefined) throw new Error("cannot pick from an empty list");
  return value;
}

function capitalize(text: string): string {
  return text.length ? text[0]!.toUpperCase() + text.slice(1) : text;
}

function generateFieldValue(
  spec: DatasetFieldSpec,
  rng: () => number,
  index: number,
  entityName: string,
  fieldName: string,
  records: Record<string, unknown[]>,
): unknown {
  switch (spec.type) {
    case "id":
      return `${spec.prefix}${String(index + 1).padStart(4, "0")}`;
    case "name":
      return `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    case "email": {
      const name = `${pick(rng, FIRST_NAMES)}.${pick(rng, LAST_NAMES)}`.toLowerCase();
      return `${name}@example.test`;
    }
    case "sentence": {
      const words = spec.words ?? 8;
      return `${capitalize(Array.from({ length: words }, () => pick(rng, LOREM_WORDS)).join(" "))}.`;
    }
    case "number":
      return spec.min + Math.floor(rng() * (spec.max - spec.min + 1));
    case "boolean":
      return rng() < 0.5;
    case "enum":
      return pick(rng, spec.values);
    case "date": {
      const span = spec.startDaysAgo - spec.endDaysAgo;
      const daysAgo = spec.endDaysAgo + Math.floor(rng() * (span + 1));
      return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
    }
    case "ref": {
      const referenced = records[spec.entity];
      if (!referenced) {
        throw new Error(
          `entity "${entityName}" field "${fieldName}" references "${spec.entity}", which is not generated yet — list referenced entities earlier`,
        );
      }
      const values = referenced.map((row) => (row as Record<string, unknown>)[spec.field]);
      return pick(rng, values);
    }
  }
}

export function generateDatasetRecords(
  entities: DatasetEntitySpec[],
  seed: number,
): Record<string, unknown[]> {
  const rng = mulberry32(seed);
  const records: Record<string, unknown[]> = {};
  for (const entity of entities) {
    const rows: Record<string, unknown>[] = [];
    for (let index = 0; index < entity.count; index++) {
      const row: Record<string, unknown> = {};
      for (const [fieldName, spec] of Object.entries(entity.fields)) {
        row[fieldName] = generateFieldValue(spec, rng, index, entity.name, fieldName, records);
      }
      rows.push(row);
    }
    records[entity.name] = rows;
  }
  return records;
}

// --- Relationship validation --------------------------------------------

export interface DatasetRelationshipViolation {
  relationship: DatasetRelationship;
  recordIndex: number;
  value: unknown;
}

function splitReference(ref: string): { entity: string; field: string } {
  const [entity, field] = ref.split(".");
  if (!entity || !field) {
    throw new Error(`invalid relationship reference "${ref}" — expected "<entity>.<field>"`);
  }
  return { entity, field };
}

/** Pure: checks every `from` value has a matching `to` value. No schema language (DDR-041). */
export function validateDatasetRelationships(
  records: Record<string, unknown[]>,
  relationships: DatasetRelationship[],
): DatasetRelationshipViolation[] {
  const violations: DatasetRelationshipViolation[] = [];
  for (const relationship of relationships) {
    const from = splitReference(relationship.from);
    const to = splitReference(relationship.to);
    const fromRecords = records[from.entity] ?? [];
    const toValues = new Set(
      (records[to.entity] ?? []).map((row) => (row as Record<string, unknown>)[to.field]),
    );
    fromRecords.forEach((row, recordIndex) => {
      const value = (row as Record<string, unknown>)[from.field];
      if (!toValues.has(value)) violations.push({ relationship, recordIndex, value });
    });
  }
  return violations;
}

function describeViolations(violations: DatasetRelationshipViolation[]): string {
  return violations
    .slice(0, 3)
    .map(
      (v) =>
        `${v.relationship.from} = ${JSON.stringify(v.value)} has no match in ${v.relationship.to}`,
    )
    .join("; ");
}

// --- Manifest serialization (DDR-028-style frontmatter, matching scenarios.ts) --

function isSafeBareValue(value: string): boolean {
  return /^[A-Za-z0-9._/@#-]+$/.test(value);
}

function serializeValue(value: string): string {
  return isSafeBareValue(value) ? value : JSON.stringify(value);
}

function parseValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function serializeManifest(manifest: DatasetManifest, description: string): string {
  const lines = [
    "---",
    "type: dataset",
    `id: ${manifest.id}`,
    `version: ${manifest.version}`,
    `title: ${manifest.title}`,
    `entities: [${manifest.entities.join(", ")}]`,
    `provenance: ${manifest.provenance}`,
  ];
  if (manifest.generator) {
    lines.push(
      `generator: ${manifest.generator.name}@${manifest.generator.version}#${manifest.generator.seed}`,
    );
  }
  if (manifest.importedAcknowledgment) {
    lines.push(`importedAcknowledgment: ${serializeValue(manifest.importedAcknowledgment)}`);
  }
  if (manifest.relationships.length > 0) {
    lines.push("relationships:");
    for (const relationship of manifest.relationships) {
      lines.push(`  ${relationship.from}: ${relationship.to}`);
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n${description.trim()}\n`;
}

function parseManifest(source: string): { manifest: DatasetManifest; description: string } | null {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const frontmatter = match[1] ?? "";
  const description = (match[2] ?? "").trim();
  const scalars: Record<string, string> = {};
  const relationships: DatasetRelationship[] = [];
  let inRelationships = false;
  for (const line of frontmatter.split(/\r?\n/)) {
    const topLevel = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (topLevel) {
      inRelationships = topLevel[1] === "relationships";
      if (!inRelationships && topLevel[2]) scalars[topLevel[1]!] = topLevel[2].trim();
      continue;
    }
    if (inRelationships) {
      const entry = line.match(/^\s+([\w.-]+):\s*(.*)$/);
      if (entry) relationships.push({ from: entry[1]!, to: parseValue(entry[2] ?? "") });
    }
  }

  if (scalars.type !== "dataset" || !scalars.id || !scalars.title) return null;
  const version = Number(scalars.version ?? "1");
  if (!Number.isInteger(version) || version < 1) return null;
  if (scalars.provenance !== "synthetic" && scalars.provenance !== "imported") return null;

  const entities = (scalars.entities ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((entity) => entity.trim())
    .filter(Boolean);

  let generator: DatasetManifest["generator"];
  const generatorMatch = scalars.generator?.match(/^(.+)@(.+)#(\d+)$/);
  if (generatorMatch) {
    generator = {
      name: generatorMatch[1]!,
      version: generatorMatch[2]!,
      seed: Number(generatorMatch[3]),
    };
  }

  return {
    manifest: {
      type: "dataset",
      id: scalars.id,
      version,
      title: scalars.title,
      entities,
      relationships,
      provenance: scalars.provenance,
      generator,
      importedAcknowledgment: scalars.importedAcknowledgment
        ? parseValue(scalars.importedAcknowledgment)
        : undefined,
    },
    description,
  };
}

async function writeDatasetFiles(
  root: string,
  slug: string,
  manifest: DatasetManifest,
  records: Record<string, unknown[]>,
  description = "",
): Promise<void> {
  const dir = datasetDir(root, slug);
  await fs.mkdir(path.join(dir, "records"), { recursive: true });
  await fs.writeFile(manifestPath(root, slug), serializeManifest(manifest, description), "utf8");
  for (const [entity, rows] of Object.entries(records)) {
    await fs.writeFile(
      recordsPath(root, slug, entity),
      `${JSON.stringify(rows, null, 2)}\n`,
      "utf8",
    );
  }
}

async function uniqueDatasetSlug(root: string, title: string): Promise<string> {
  const base = slugify(title);
  let candidate = base;
  let suffix = 2;
  while (true) {
    try {
      await fs.access(datasetDir(root, candidate));
      candidate = `${base}-${suffix}`;
      suffix += 1;
    } catch {
      return candidate;
    }
  }
}

// --- Public lifecycle -----------------------------------------------------

export interface CreateDatasetOptions {
  cwd?: string;
  title: string;
  entities: DatasetEntitySpec[];
  relationships?: DatasetRelationship[];
  seed: number;
  generatorVersion?: string;
  description?: string;
}

/** Synthetic-only generation path. Forge never copies real data by default (DDR-046). */
export async function createDataset(options: CreateDatasetOptions): Promise<Dataset> {
  const root = path.resolve(options.cwd ?? process.cwd());
  const records = generateDatasetRecords(options.entities, options.seed);
  const relationships = options.relationships ?? [];
  const violations = validateDatasetRelationships(records, relationships);
  if (violations.length > 0) {
    throw new Error(
      `generated dataset violates ${violations.length} declared relationship(s): ${describeViolations(violations)}`,
    );
  }
  const slug = await uniqueDatasetSlug(root, options.title);
  const manifest: DatasetManifest = {
    type: "dataset",
    id: generateDatasetId(),
    version: 1,
    title: options.title.trim(),
    entities: options.entities.map((entity) => entity.name),
    relationships,
    provenance: "synthetic",
    generator: {
      name: "forge-datasets",
      version: options.generatorVersion ?? "1.0.0",
      seed: options.seed,
    },
  };
  await writeDatasetFiles(root, slug, manifest, records, options.description ?? "");
  return { manifest, records, slug, dir: path.join("datasets", slug) };
}

export interface ImportDatasetOptions {
  cwd?: string;
  title: string;
  records: Record<string, unknown[]>;
  relationships?: DatasetRelationship[];
  /** A human-written statement of what this is and why importing it is warranted (DDR-046). */
  acknowledgment: string;
  description?: string;
}

export async function importDataset(options: ImportDatasetOptions): Promise<Dataset> {
  const acknowledgment = options.acknowledgment.trim();
  if (acknowledgment.length < MIN_ACKNOWLEDGMENT_LENGTH) {
    throw new Error(
      `imported datasets require a written acknowledgment of at least ${MIN_ACKNOWLEDGMENT_LENGTH} characters — Forge never copies real data by default`,
    );
  }
  const root = path.resolve(options.cwd ?? process.cwd());
  const relationships = options.relationships ?? [];
  const violations = validateDatasetRelationships(options.records, relationships);
  if (violations.length > 0) {
    throw new Error(
      `imported dataset violates ${violations.length} declared relationship(s): ${describeViolations(violations)}`,
    );
  }
  const slug = await uniqueDatasetSlug(root, options.title);
  const manifest: DatasetManifest = {
    type: "dataset",
    id: generateDatasetId(),
    version: 1,
    title: options.title.trim(),
    entities: Object.keys(options.records),
    relationships,
    provenance: "imported",
    importedAcknowledgment: acknowledgment,
  };
  await writeDatasetFiles(root, slug, manifest, options.records, options.description ?? "");
  return { manifest, records: options.records, slug, dir: path.join("datasets", slug) };
}

async function readDataset(root: string, slug: string): Promise<Dataset> {
  const raw = await fs.readFile(manifestPath(root, slug), "utf8");
  const parsed = parseManifest(raw);
  if (!parsed) throw new Error(`dataset ${slug} is malformed`);
  const records: Record<string, unknown[]> = {};
  for (const entity of parsed.manifest.entities) {
    records[entity] = JSON.parse(await fs.readFile(recordsPath(root, slug, entity), "utf8"));
  }
  return { manifest: parsed.manifest, records, slug, dir: path.join("datasets", slug) };
}

export async function listDatasets(cwd?: string): Promise<Dataset[]> {
  const root = path.resolve(cwd ?? process.cwd());
  let entries: string[];
  try {
    entries = await fs.readdir(datasetsRoot(root));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const datasets: Dataset[] = [];
  for (const entry of entries) {
    try {
      datasets.push(await readDataset(root, entry));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
  return datasets.sort((a, b) => a.manifest.title.localeCompare(b.manifest.title));
}

export async function getDataset(slug: string, cwd?: string): Promise<Dataset | null> {
  const root = path.resolve(cwd ?? process.cwd());
  try {
    return await readDataset(root, slug);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export interface UpdateDatasetOptions {
  records?: Record<string, unknown[]>;
  relationships?: DatasetRelationship[];
  description?: string;
}

/**
 * Bumps the dataset's version and overwrites its records/manifest in place —
 * there is no per-version snapshot the way scenarios keep one; Git history
 * of the same path is the recovery mechanism for old versions (DDR-046).
 */
export async function updateDataset(
  slug: string,
  edit: UpdateDatasetOptions,
  cwd?: string,
): Promise<Dataset> {
  const root = path.resolve(cwd ?? process.cwd());
  const current = await readDataset(root, slug);
  const records = edit.records ?? current.records;
  const relationships = edit.relationships ?? current.manifest.relationships;
  const violations = validateDatasetRelationships(records, relationships);
  if (violations.length > 0) {
    throw new Error(
      `updated dataset violates ${violations.length} declared relationship(s): ${describeViolations(violations)}`,
    );
  }
  const manifest: DatasetManifest = {
    ...current.manifest,
    version: current.manifest.version + 1,
    entities: Object.keys(records),
    relationships,
  };
  const parsedCurrent = parseManifest(await fs.readFile(manifestPath(root, slug), "utf8"));
  await writeDatasetFiles(
    root,
    slug,
    manifest,
    records,
    edit.description ?? parsedCurrent?.description ?? "",
  );
  return { manifest, records, slug, dir: path.join("datasets", slug) };
}

// --- Reference resolution (scenario `dataset: ds-<id>@<version>`) ---------

export function parseDatasetReference(ref: string): { id: string; version: number } | null {
  const match = ref.match(/^(ds-[0-9a-hjkmnp-tv-z]{8})@(\d+)$/);
  if (!match) return null;
  return { id: match[1]!, version: Number(match[2]) };
}

/**
 * Resolves against the CURRENT working tree only — an older pinned version
 * that has since been superseded isn't kept as a separate file (DDR-046);
 * recovering it means checking out the Git commit that wrote it.
 */
export async function resolveDatasetReference(ref: string, cwd?: string): Promise<Dataset | null> {
  const parsed = parseDatasetReference(ref);
  if (!parsed) return null;
  const datasets = await listDatasets(cwd);
  const dataset = datasets.find((d) => d.manifest.id === parsed.id);
  if (!dataset || dataset.manifest.version !== parsed.version) return null;
  return dataset;
}
