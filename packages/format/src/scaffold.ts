// The empty Design Record (spec/format.md §2, "Created: init"). Progressive
// scaffolding means this is the whole of it — every other file in the file set
// appears the first time content exists for it.
//
// These templates are structure, not content: section headings the parsers and
// `forge doctor` expect, plus one line saying what belongs in the file. Nothing
// here asserts a fact about the project, because spec §1 principle 3 is that an
// agent reads a rotted template as truth.
//
// v0.2 scaffolds an OKF bundle under `design/`. Two files the v0.1 core set had
// are deliberately absent: a glossary and open questions are *directories* of
// concepts now, and an empty directory is both untrackable in git and exactly
// the rot principle 3 warns about. They appear with their first concept.

import { BUNDLE_DIR } from "./bundle.js";
import { buildBundleIndex } from "./bundle-index.js";
import { parseConcept } from "./concepts.js";
import { V02_FORMAT_VERSION } from "./forge-json.js";
import { withFrontmatter } from "./frontmatter.js";
import { TASK_SECTIONS } from "./todos.js";

/** `decisions/` is scaffolded with the template DDR the doctor exempts by name. */
export const DDR_TEMPLATE_PATH = "decisions/DDR-000-template.md";

const BRIEF = withFrontmatter(
  { type: "Brief", title: "Brief" },
  `# Brief

What this project is, who it is for, and what it is deliberately not. This file
is the genesis: the requirements and definitions the work started from.

## What it is

## Who it's for

## What it is not
`,
);

const TODOS = withFrontmatter(
  { type: "Task Ledger", title: "Todos" },
  `${TASK_SECTIONS.map((section) => `## ${section}`).join("\n\n")}\n`,
);

const DDR_TEMPLATE = withFrontmatter(
  {
    type: "Decision",
    id: "DDR-000",
    title: "Title",
    decision_status: "draft",
    context_source:
      "(meeting, transcript, exploration branch, or conversation that triggered this)",
  },
  `## Decision

One paragraph stating what was decided.

## Why

The forces at play and the reasoning.

## Alternatives rejected

What else was considered and why it lost.

## Consequences

What this makes easier, what it makes harder, what it commits us to.
`,
);

/**
 * Path → contents for a new record, relative to the repo root. Callers write
 * only the paths that do not already exist: adopting a repo that has some of
 * these is the normal case, and nothing here may overwrite real content.
 */
export function coreScaffold(recordRoot: string = BUNDLE_DIR): Record<string, string> {
  const concepts = [
    parseConcept("brief.md", BRIEF),
    parseConcept("todos.md", TODOS),
    parseConcept(DDR_TEMPLATE_PATH, DDR_TEMPLATE),
  ];
  return {
    // Generated through the same builder `forge index` uses, so a fresh record
    // never starts out stale (T-300).
    [`${recordRoot}/index.md`]: buildBundleIndex(concepts),
    [`${recordRoot}/brief.md`]: BRIEF,
    [`${recordRoot}/todos.md`]: TODOS,
    [`${recordRoot}/${DDR_TEMPLATE_PATH}`]: DDR_TEMPLATE,
    "forge.json": `${JSON.stringify({ formatVersion: V02_FORMAT_VERSION, recordRoot }, null, 2)}\n`,
  };
}
