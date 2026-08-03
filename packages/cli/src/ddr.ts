// `forge ddr apply` — the write side of the `ddr` skill (spec/format.md,
// decisions/DDR-000-template.md). The skill has the conversation and forms
// the judgment; this command is the only path from that judgment into
// decisions/ — mirrors the intake/triage stage-then-apply shape (T-229/230):
// the skill stages `.forge/ddr/<slug>.json` directly (staging isn't the
// record), then this command validates, allocates the DDR-### id, and
// writes the file.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  DDR_BASE_STATUSES,
  type DdrBaseStatus,
  nextId,
  scanBundle,
  withFrontmatter,
} from "@forgedesign/format";
import { writeBundleIndex } from "./bundle-index.js";
import { todayIsoDate } from "./freezes.js";
import { requireCurrentRecord } from "./record-version.js";

export const SLUG_RE = /^[a-z][a-z0-9-]*$/;

export interface StagedDdr {
  title: string;
  status?: string;
  /** when the decision was actually made; defaults to today (T-258) */
  date?: string;
  contextSource: string;
  /**
   * The accepted decisions this one changes part of (DDR-090).
   *
   * Declared here rather than inferred from the prose, because a decision that
   * *describes* other amendments reads identically to one that makes them —
   * DDR-087 is exactly that document. `forge doctor` checks each target carries
   * the matching `amended_by`, which is the half that kept going unwritten.
   */
  amends?: string[];
  decision: string;
  why: string;
  alternativesRejected?: string;
  consequences?: string;
}

export interface ApplyDdrResult {
  id: string;
  path: string;
}

function stagePath(root: string, slug: string): string {
  return path.join(root, ".forge", "ddr", `${slug}.json`);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`.forge/ddr/<slug>.json is missing required field "${field}"`);
  }
  return value;
}

const DDR_ID_RE = /^DDR-\d{3,}$/;

/** `amends` is a list of decision ids or it is nothing — a typo here is a lie. */
function readAmends(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !DDR_ID_RE.test(entry.trim())) {
      throw new Error(
        `amends must be a list of decision ids like ["DDR-088"] — got ${JSON.stringify(value)}`,
      );
    }
    out.push(entry.trim());
  }
  return out.length > 0 ? out : undefined;
}

function isDdrBaseStatus(value: string): value is DdrBaseStatus {
  return (DDR_BASE_STATUSES as readonly string[]).includes(value);
}

/** The concept shape: the header block's three fields are frontmatter (DDR-060). */
function buildDdrConcept(id: string, staged: StagedDdr, status: string, date: string): string {
  const sections = ["## Decision", "", staged.decision.trim(), "", "## Why", "", staged.why.trim()];
  if (staged.alternativesRejected) {
    sections.push("", "## Alternatives rejected", "", staged.alternativesRejected.trim());
  }
  if (staged.consequences) {
    sections.push("", "## Consequences", "", staged.consequences.trim());
  }
  return withFrontmatter(
    {
      type: "Decision",
      id,
      title: staged.title,
      date,
      decision_status: status,
      ...(staged.amends?.length ? { amends: staged.amends } : {}),
      context_source: staged.contextSource,
    },
    `${sections.join("\n")}\n`,
  );
}

/**
 * Reads `.forge/ddr/<slug>.json` (written by the `ddr` skill), allocates the
 * next DDR-### id by scanning decisions/, and writes decisions/DDR-###-<slug>.md.
 */
export async function applyDdr(root: string, slug: string): Promise<ApplyDdrResult> {
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `"${slug}" must be a lowercase slug (a-z, 0-9, hyphens) — e.g. "pivot-design-record"`,
    );
  }

  const stagedFile = stagePath(root, slug);
  let raw: string;
  try {
    raw = await fs.readFile(stagedFile, "utf8");
  } catch {
    throw new Error(
      `no staged decision found at .forge/ddr/${slug}.json — capture the decision in your agent session first, then rerun "forge ddr apply".`,
    );
  }
  const parsed = JSON.parse(raw) as Partial<StagedDdr>;
  const staged: StagedDdr = {
    title: requireString(parsed.title, "title"),
    contextSource: requireString(parsed.contextSource, "contextSource"),
    decision: requireString(parsed.decision, "decision"),
    why: requireString(parsed.why, "why"),
    alternativesRejected:
      typeof parsed.alternativesRejected === "string" ? parsed.alternativesRejected : undefined,
    consequences: typeof parsed.consequences === "string" ? parsed.consequences : undefined,
    date: typeof parsed.date === "string" ? parsed.date : undefined,
    amends: readAmends(parsed.amends),
  };
  const status = parsed.status?.trim() || "draft";
  if (!isDdrBaseStatus(status)) {
    throw new Error(`status must be one of ${DDR_BASE_STATUSES.join(", ")} — got "${status}"`);
  }

  // DDR-095: one layout is written. An older record is refused with the sentence
  // that names its way out, rather than served by a second writer.
  const { recordRoot } = await requireCurrentRecord(root);
  const bundle = await scanBundle(root, { recordRoot });
  const existingIds = bundle.concepts.flatMap((c) => (c.type === "Decision" && c.id ? [c.id] : []));
  const id = nextId(existingIds, "DDR");

  const decisionsDir = path.join(recordRoot, "decisions");
  const relPath = path.join(decisionsDir, `${id}-${slug}.md`);
  // Back-filling a project's decision history is the main on-ramp DDR-050
  // implies, and it is the case a hardcoded "today" gets wrong (T-258).
  const date = staged.date ?? todayIsoDate();
  const contents = buildDdrConcept(id, staged, status, date);

  await fs.mkdir(path.join(root, decisionsDir), { recursive: true });
  await fs.writeFile(path.join(root, relPath), contents, "utf8");
  // The index is derived from the concept listing, so the writer that adds a
  // concept is the one that keeps it true (T-300).
  await writeBundleIndex(root);

  return { id, path: relPath };
}
