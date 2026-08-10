// `forge adopt` — what a repo that already documents itself could bring into
// the record, and what it must not (TASK-393).
//
// **Read-only, and that is the whole design.** The creator's question was
// whether `forge init` should rewrite existing documentation to fit. It should
// not, and the argument is about truth rather than ownership: existing docs are
// stale in unknown ways — a README describing a flow that changed, an ADR folder
// from two years ago — and bulk-converting them makes the record *confidently
// wrong*. Doctor would then enforce internal consistency across content nobody
// verified, which is worse than having no record at all: it launders unchecked
// prose into something that looks contract-checked. So this reports and
// proposes; every promotion goes through a path where a human sees the item.
//
// **Nothing else in the repo has to change**, and saying so is half the value.
// OKF constrains `.md` files inside the bundle tree, the bundle roots at
// `design/`, and a real repo always has a `README.md` that carries no
// frontmatter — which is exactly why the bundle is a subdirectory. A project
// with ten years of `docs/` complies the moment `design/` exists.
//
// **Dates are the one thing worth being eager about.** A decision's date is most
// of its meaning, and `forge ddr apply` takes one precisely so a 2024 ADR
// becomes a DDR dated 2024. This reads the date a file was first committed and
// reports it, so back-dating is the default rather than something a creator has
// to think of.

import { bundleRootOf } from "./bundle-index.js";
import { git, requireRepoRoot } from "./git.js";

/** Where a piece of existing documentation could go. */
export type Destination = "decision" | "concept" | "history";

export interface Candidate {
  /** repo-relative path */
  file: string;
  destination: Destination;
  /** why it was classified this way, in the report's own words */
  because: string;
  /** the command that would take it there */
  next: string;
  /** first commit date, for the decisions where it is load-bearing */
  dated?: string;
}

interface Rule {
  test: RegExp;
  destination: Destination;
  because: string;
  next: string;
}

/**
 * Filename rules, most specific first.
 *
 * Deliberately shallow: this classifies by *name*, not by reading content, so a
 * wrong guess is a line in a report rather than a wrong file in the record. The
 * one thing it must not do is sound certain — every `because` describes the
 * evidence ("named like an ADR"), not a conclusion about what the file is.
 */
const RULES: Rule[] = [
  {
    test: /(^|\/)(adr|adrs|decisions?|rfcs?)\/|(^|\/)(adr|rfc)[-_]?\d+|decision-record/i,
    destination: "decision",
    because: "sits in a decision folder, or is named like an ADR or RFC",
    next: "stage it as a DDR with its original date — `forge ddr apply` takes one",
  },
  {
    test: /(^|\/)(glossary|terminology|terms)[^/]*\.md$/i,
    destination: "concept",
    because: "reads as a glossary",
    next: "`forge add term <name>` — one file per term, and only the terms still true",
  },
  {
    test: /(^|\/)(data[-_]?model|schema|entities|erd)[^/]*\.md$/i,
    destination: "concept",
    because: "reads as a data model",
    next: "`forge add data-model`",
  },
  {
    test: /(^|\/)(design[-_]?system|style[-_]?guide|tokens)[^/]*\.md$/i,
    destination: "concept",
    because: "reads as a design system",
    next: "`forge add design-system`",
  },
  {
    test: /(^|\/)components?[^/]*\.md$/i,
    destination: "concept",
    because: "reads as a component inventory",
    next: "`forge add components`",
  },
  {
    test: /(^|\/)(flows?|journeys?|user[-_]?flows?)[^/]*\.md$/i,
    destination: "concept",
    because: "reads as a process flow",
    next: "`forge add flow <name>` — Mermaid only",
  },
  {
    test: /(^|\/)(roles?|personas?)[^/]*\.md$/i,
    destination: "concept",
    because: "reads as roles or personas",
    next: "`forge add role <name>`",
  },
  {
    test: /(^|\/)(todos?|tasks?|backlog|roadmap)[^/]*\.md$/i,
    destination: "concept",
    because: "reads as a task list",
    next: "`forge task add` — with the dates and causes the old list already knows",
  },
];

const HISTORY: Rule = {
  test: /\.md$/i,
  destination: "history",
  because: "prose the record has no home for",
  next: "`forge intake <file>` — stage it, and let a session propose what it holds",
};

export function classify(file: string): Rule {
  return RULES.find((rule) => rule.test.test(file)) ?? HISTORY;
}

/** Files this never looks at: the record itself, and anything not tracked prose. */
export function isSkipped(file: string, recordRoot: string | null): boolean {
  if (!/\.md$/i.test(file)) return true;
  if (recordRoot && (file === recordRoot || file.startsWith(`${recordRoot}/`))) return true;
  return /(^|\/)(node_modules|\.forge|dist|build|coverage|vendor)\//.test(file);
}

export interface AdoptReport {
  /** where the record lives, or null when there is none yet */
  recordRoot: string | null;
  candidates: Candidate[];
}

/**
 * Everything Git tracks, so `.gitignore` is honoured for free and a `dist/`
 * full of generated markdown never reaches the report. A repo is a hard
 * requirement here rather than a convenience: the dates come from history.
 */
export async function scanForAdoption(cwd: string, limit = 200): Promise<AdoptReport> {
  const root = await requireRepoRoot(cwd);
  const recordRoot = await bundleRootOf(root);

  const tracked = (await git(root, ["ls-files", "*.md", "**/*.md"]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const seen = new Set<string>();
  const files = tracked.filter((file) => {
    if (seen.has(file) || isSkipped(file, recordRoot)) return false;
    seen.add(file);
    return true;
  });

  const candidates: Candidate[] = [];
  for (const file of files.slice(0, limit)) {
    const rule = classify(file);
    const candidate: Candidate = {
      file,
      destination: rule.destination,
      because: rule.because,
      next: rule.next,
    };
    if (rule.destination === "decision") {
      // A decision's date is most of its meaning, so it is worth one git call
      // each to recover — only for decisions, which keeps this bounded.
      const dated = await firstCommitDate(root, file);
      if (dated) candidate.dated = dated;
    }
    candidates.push(candidate);
  }
  return { recordRoot, candidates };
}

async function firstCommitDate(root: string, file: string): Promise<string | null> {
  try {
    const out = await git(root, [
      "log",
      "--diff-filter=A",
      "--format=%ad",
      "--date=short",
      "-1",
      "--",
      file,
    ]);
    return out.trim() || null;
  } catch {
    // A file that git cannot date is still worth reporting; the date is a bonus.
    return null;
  }
}

/** Grouped for the report, in the order the three destinations should be read. */
export function groupCandidates(candidates: Candidate[]): Array<[Destination, Candidate[]]> {
  const order: Destination[] = ["decision", "concept", "history"];
  return order
    .map((destination): [Destination, Candidate[]] => [
      destination,
      candidates.filter((candidate) => candidate.destination === destination),
    ])
    .filter(([, group]) => group.length > 0);
}

export const DESTINATION_HEADINGS: Record<Destination, string> = {
  decision:
    "Decisions already made — these become DDRs, dated when they were written rather than today",
  concept: "Still true about the product? — then they become concepts. Confirm before promoting",
  history: "History — context, not record. It belongs outside the bundle",
};

/** The line that answers the creator's third question, and it is the reassuring one. */
export const COMPLIANCE_NOTE =
  "Nothing else in this repo has to change. The record is a subdirectory, and the format " +
  "constrains only what is inside it — a project with ten years of docs/ complies the moment " +
  "that directory exists.";

export const TRUTH_NOTE =
  "Nothing here was written, moved or changed. Promote one item at a time, and only what you " +
  "can still vouch for: a record filled with unverified prose is worse than an empty one, " +
  "because doctor then checks it and it looks true.";
