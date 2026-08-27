// `forge review apply` — the write side of the `review` skill (DDR-108,
// DDR-112).
//
// The skill runs the four-vector rubric in the user's own agent session: it
// reads the record, walks the built prototype, and forms judgments. This
// command is the only path from those judgments into `design/feedback/`, the
// same division every other skill uses — skills talk, the CLI writes, so the
// file shapes and ids stay deterministic no matter which agent ran the review.
//
// **Findings are feedback, not a report.** DDR-108 fixes this: a finding enters
// as a `source: scan` feedback concept and flows through the triage →
// disposition → resolution-trail machinery the record already has. There is no
// second format to learn, no score, and nothing here blocks a freeze. They land
// `pending` because dispositioning them is the human's act, not the scanner's —
// a scan that dispositioned its own findings would be a gate, and the gate is
// Cloud's (DDR-057).

import { promises as fs } from "node:fs";
import path from "node:path";
import { nextId, scanBundle, withFrontmatter } from "@forgedesign/format";
import { writeBundleIndex } from "./bundle-index.js";
import { todayIsoDate } from "./freezes.js";
import { requireCurrentRecord } from "./record-version.js";

/**
 * The four vectors of DDR-108's rubric, as they are written into a finding.
 *
 * Named rather than numbered: `vector: 2` in a record two years from now says
 * nothing, and the numbering is DDR-108's presentation order rather than a
 * property of the vectors themselves.
 */
export const REVIEW_VECTORS = ["utility", "coherence", "hierarchy", "viability"] as const;
export type ReviewVector = (typeof REVIEW_VECTORS)[number];

export interface StagedFinding {
  vector: string;
  /** the finding itself; becomes the concept's blockquote body */
  finding: string;
  /** one line for the concept's title; derived from `finding` when absent */
  title?: string;
  /** where in the prototype, when the vector is about something on screen */
  route?: string;
  selector?: string;
  /** what the reviewer was working through, when the finding came from a flow */
  scenario?: string;
  step?: string;
}

export interface ApplyReviewResult {
  ids: string[];
  paths: string[];
}

const MAX_TITLE = 120;
const MAX_FINDING = 4000;
const MAX_FIELD = 2000;

export const reviewStagePath = (root: string): string =>
  path.join(root, ".forge", "review", "findings.json");

/** One line, so a title never smuggles a newline into frontmatter. */
const oneLine = (text: string): string => text.replace(/\s*\r?\n\s*/g, " ").trim();

function isVector(value: unknown): value is ReviewVector {
  return typeof value === "string" && (REVIEW_VECTORS as readonly string[]).includes(value);
}

function optionalField(value: unknown, field: string, index: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > MAX_FIELD) {
    throw new Error(
      `finding ${index + 1}: "${field}" must be a string of at most ${MAX_FIELD} characters`,
    );
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Every finding checked before any of them is written.
 *
 * The same rule `forge comments triage apply` follows, for the same reason: a
 * half-applied batch leaves the record holding some of a review, and the only
 * way to tell which half is to read it. A bad `scenario` id is the case worth
 * naming — a finding that cites a scenario the record does not have is a
 * dangling reference `forge doctor` would report later, in a file the skill
 * wrote and the human did not.
 */
export function validateFindings(
  value: unknown,
  scenarioIds: ReadonlySet<string>,
): StagedFinding[] {
  const findings = (value as { findings?: unknown })?.findings;
  if (!Array.isArray(findings)) {
    throw new Error('.forge/review/findings.json must hold a "findings" array');
  }

  return findings.map((raw, index) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`finding ${index + 1}: expected an object`);
    }
    const item = raw as Record<string, unknown>;

    if (!isVector(item.vector)) {
      throw new Error(
        `finding ${index + 1}: "vector" must be one of ${REVIEW_VECTORS.join(", ")} — got ${JSON.stringify(item.vector)}`,
      );
    }
    if (typeof item.finding !== "string" || item.finding.trim() === "") {
      throw new Error(`finding ${index + 1}: "finding" is required`);
    }
    if (item.finding.length > MAX_FINDING) {
      throw new Error(`finding ${index + 1}: "finding" exceeds ${MAX_FINDING} characters`);
    }

    const scenario = optionalField(item.scenario, "scenario", index);
    if (scenario !== undefined && !scenarioIds.has(scenario)) {
      throw new Error(`finding ${index + 1}: scenario "${scenario}" does not exist in this record`);
    }
    const step = optionalField(item.step, "step", index);
    // A step without a scenario names a position in a flow nobody can find.
    if (step !== undefined && scenario === undefined) {
      throw new Error(`finding ${index + 1}: "step" needs the "scenario" it belongs to`);
    }

    const title = optionalField(item.title, "title", index) ?? oneLine(item.finding);
    return {
      vector: item.vector,
      finding: item.finding.trim(),
      title: title.slice(0, MAX_TITLE),
      route: optionalField(item.route, "route", index),
      selector: optionalField(item.selector, "selector", index),
      scenario,
      step,
    };
  });
}

/**
 * Reads `.forge/review/findings.json` (written by the `review` skill),
 * allocates a `FEEDBACK-###` per finding, and writes the concepts.
 *
 * The staged file is removed on success. Applying twice would file every
 * finding a second time under fresh ids, and nothing downstream could tell the
 * duplicates from a reviewer who genuinely said it twice.
 */
export async function applyReview(root: string): Promise<ApplyReviewResult> {
  const stagedFile = reviewStagePath(root);
  let raw: string;
  try {
    raw = await fs.readFile(stagedFile, "utf8");
  } catch {
    throw new Error(
      "no staged review found at .forge/review/findings.json — run the review skill first, then rerun `forge review apply`.",
    );
  }

  const { recordRoot } = await requireCurrentRecord(root);
  const bundle = await scanBundle(root, { recordRoot });
  const scenarioIds = new Set(
    bundle.concepts.flatMap((c) => (c.type === "Scenario" && c.id ? [c.id] : [])),
  );

  const findings = validateFindings(JSON.parse(raw), scenarioIds);
  if (findings.length === 0) {
    throw new Error(".forge/review/findings.json holds no findings — nothing to apply.");
  }

  const allocated = bundle.concepts.flatMap((c) => (c.type === "Feedback" && c.id ? [c.id] : []));
  const date = todayIsoDate();
  const feedbackDir = path.join(recordRoot, "feedback");
  await fs.mkdir(path.join(root, feedbackDir), { recursive: true });

  const ids: string[] = [];
  const paths: string[] = [];
  for (const item of findings) {
    const id = nextId(allocated, "FEEDBACK");
    allocated.push(id);
    const relPath = path.join(feedbackDir, `${id}.md`);
    await fs.writeFile(
      path.join(root, relPath),
      withFrontmatter(
        {
          type: "Feedback",
          id,
          title: item.title,
          date,
          // Pending, always: the scan reports, the human decides (DDR-108).
          feedback_status: "pending",
          source: "scan",
          vector: item.vector,
          route: item.route,
          selector: item.selector,
          scenario: item.scenario,
          step: item.step,
        },
        `> ${oneLine(item.finding)}\n`,
      ),
      "utf8",
    );
    ids.push(id);
    paths.push(relPath);
  }

  // The index is derived from the concept listing, so the writer that adds a
  // concept keeps it true (T-300).
  await writeBundleIndex(root);
  await fs.rm(stagedFile, { force: true });

  return { ids, paths };
}
