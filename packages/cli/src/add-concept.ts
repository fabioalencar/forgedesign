// `forge add <concept>` — the on-demand half of the format, made findable
// (TASK-391).
//
// **The problem this solves is discoverability, not scaffolding.** Ten of the
// bundle's concepts are "created on demand" (spec §2), and the practical effect
// of on demand turned out to be *never*: `login-demo` went through a complete
// review loop — freeze, publish, a real stakeholder, triage, resolution — and
// still had no glossary, no roles, no flows, no data model, no design system, no
// component inventory and no calendar, because nothing at any point tells a
// creator they exist. Nine of the dashboard's fifteen views had nothing to
// render, and doctor stayed clean throughout, because none of it is required.
//
// **Chosen over the two alternatives TASK-391 costed** (see DDR-103). A wizard
// at `forge init` puts the choice at the moment of least patience and would
// block in the two places nobody is watching — an agent session and CI
// (TASK-344). Scaffolding every concept up front contradicts spec §1 principle
// 3 outright: empty templates are rot, and agents read rot as truth. A command
// costs nothing at init, makes the whole set visible through `--help` and a bare
// `forge add`, and only ever writes a file somebody asked for.
//
// **The catalogue is keyed by the format's own `ConceptType`**, so it is a
// `Record<ConceptType, …>` rather than a second list beside the first: adding a
// type to `CONCEPT_TYPES` fails this build until it is described here. The
// directories, ids and status fields are read from `@forgedesign/format`'s tables —
// the same ones `forge doctor` validates against — so where a concept lives is
// never stated twice.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  type ConceptType,
  DOMAIN_STATUS_FIELDS,
  ID_BEARING_TYPES,
  nextId,
  ROOT_CONCEPT_FILES,
  scanBundle,
  TYPE_DIRECTORIES,
  withFrontmatter,
} from "@forgedesign/format";
import { writeBundleIndex } from "./bundle-index.js";
import { todayIsoDate } from "./freezes.js";
import { requireCurrentRecord } from "./record-version.js";

export interface ConceptEntry {
  /** What a user types. The directory name is always an alias, because guessing
   *  singular-versus-plural is exactly the failure this command exists to end. */
  keys: string[];
  /** One line, from spec §2's table. */
  purpose: string;
  /** Set when another command owns writing this one — `forge add` then explains
   *  rather than writing, so there is never a second way to make a `DDR-###`. */
  writtenBy?: string;
  /** What belongs in the body, carried into the file as an HTML comment. */
  guidance?: string;
  /** Prompted for on the command line: a term, a title. Absent for the four
   *  single-file concepts, which are named by the format. */
  names?: string;
}

/**
 * Every type the format has. Exhaustive by construction — this is the drift
 * guard, and it is a compile error rather than a convention.
 */
export const CONCEPT_CATALOGUE: Record<ConceptType, ConceptEntry> = {
  Brief: {
    keys: ["brief"],
    purpose: "What this project is, who it is for, and what it is deliberately not",
    writtenBy: "forge init",
  },
  "Task Ledger": {
    keys: ["todos", "tasks"],
    purpose: "Tasks with status, dates, and what caused each one",
    writtenBy: "forge init (then `forge task add`)",
  },
  "Feature Log": {
    keys: ["feature-log"],
    purpose: "Features closed per freeze",
    writtenBy: "forge freeze (generated)",
  },
  Decision: {
    keys: ["decision", "decisions", "ddr"],
    purpose: "One decision, with its rationale and the alternatives it beat",
    writtenBy: "forge ddr apply",
  },
  Question: {
    keys: ["question", "questions"],
    purpose: "Something unresolved, to explore with stakeholders",
    writtenBy: "forge question",
  },
  Feedback: {
    keys: ["feedback"],
    purpose: "One piece of feedback, with its disposition",
    writtenBy: "forge comments triage apply",
  },

  // The on-demand set, which is what this command is for.
  Term: {
    keys: ["term", "glossary"],
    names: "the term",
    purpose: "One term that carries project meaning",
    guidance:
      "One term, defined in a sentence or two. Use the project's own vocabulary — " +
      "the nouns in the codebase a newcomer would guess wrong.",
  },
  Story: {
    keys: ["story", "stories"],
    names: "what the story is",
    purpose: "A user story introduced along the iterations",
    guidance:
      "Who wants what, and why it matters to them. Link the flows and roles it " +
      "touches by id so the record joins up.",
  },
  Role: {
    keys: ["role", "roles"],
    names: "the role's name",
    purpose: "A role assumption; seeds the role switcher on hosted reviews",
    guidance:
      "Who this person is and what they may do. Declare capabilities in a " +
      "`permissions:` frontmatter list — a scenario composes on top of them " +
      "(spec §4).",
  },
  Stakeholder: {
    keys: ["stakeholder", "stakeholders"],
    names: "who they are",
    purpose: "A minimal stakeholder profile and what they contributed",
    guidance:
      "Enough to know whose opinion this is and what they reviewed. Keep it " +
      "minimal: a person who was sent a link and never signed up cannot edit " +
      "or remove what is written here.",
  },
  Flow: {
    keys: ["flow", "flows"],
    names: "what the flow is",
    purpose: "An end-to-end process flow",
    guidance:
      "One process from start to finish, as a Mermaid diagram — Mermaid only, " +
      "no other diagram syntax.",
  },
  Scenario: {
    keys: ["scenario", "scenarios"],
    names: "what the scenario sets up",
    purpose: "What the prototype runs under for one review: role, flags, route rules, dataset",
    guidance:
      "The state a reviewer meets: which role, which permissions on top of that " +
      "role's, which flags and route rules, which dataset, and the flow to walk.",
  },
  Calendar: {
    keys: ["calendar"],
    purpose: "Deadlines, checkpoints, and the timeline",
    guidance:
      "Dates that bind, each naming what it belongs to by id — a decision, a " +
      "freeze — rather than restating it.",
  },
  "Data Model": {
    keys: ["data-model"],
    purpose: "Entities, shapes, enums, relationships, and business rules the prototype observes",
    guidance:
      "What the data *is*, not how it is served: entities, their fields and " +
      "enums, how they relate, and the rules that hold regardless of storage.",
  },
  "Design System": {
    keys: ["design-system"],
    purpose: "Design tokens and brand direction",
    guidance: "Tokens and the direction behind them. Links the component inventory.",
  },
  "Component Inventory": {
    keys: ["components"],
    purpose: "The component inventory",
    guidance: "What exists, what each is for, and where it is used.",
  },
};

/** Types this command writes — the rest name the command that owns them. */
export function addableTypes(): ConceptType[] {
  return (Object.keys(CONCEPT_CATALOGUE) as ConceptType[]).filter(
    (type) => CONCEPT_CATALOGUE[type].writtenBy === undefined,
  );
}

/** The key a user typed, resolved to a type. Case- and plural-insensitive. */
export function resolveConcept(key: string): ConceptType | null {
  const wanted = key.trim().toLowerCase();
  for (const type of Object.keys(CONCEPT_CATALOGUE) as ConceptType[]) {
    if (CONCEPT_CATALOGUE[type].keys.includes(wanted)) return type;
    if (type.toLowerCase() === wanted) return type;
  }
  return null;
}

export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface AddConceptResult {
  type: ConceptType;
  /** repo-relative path written */
  path: string;
  /** allocated id, for the types that carry one */
  id: string | null;
}

/**
 * The body a new concept opens with.
 *
 * An HTML comment rather than placeholder prose, and that is the whole point:
 * spec §1 principle 3 says empty templates are rot because agents read rot as
 * truth, so the file must not contain a sentence that could be mistaken for
 * content. A comment renders as nothing in GitHub, Obsidian or any viewer
 * (principle 5), while still telling whoever opens the file what belongs in it.
 * It costs one line to delete and says nothing untrue if it is left.
 */
function starterBody(entry: ConceptEntry): string {
  return entry.guidance ? `<!-- ${entry.guidance} -->\n` : "";
}

export async function addConcept(
  root: string,
  key: string,
  name?: string,
): Promise<AddConceptResult> {
  const type = resolveConcept(key);
  if (type === null) {
    throw new Error(
      `"${key}" is not a concept in this format — run \`forge add\` to see the whole set`,
    );
  }
  const entry = CONCEPT_CATALOGUE[type];
  if (entry.writtenBy) {
    throw new Error(`a ${type} is written by \`${entry.writtenBy}\`, not by \`forge add\``);
  }

  // A writer on a pre-0.2 record gets one sentence naming its way out (DDR-095),
  // rather than a second layout written beside the first.
  const { recordRoot } = await requireCurrentRecord(root);
  const bundle = await scanBundle(root, { recordRoot });

  const dir = TYPE_DIRECTORIES[type];
  let relPath: string;
  let id: string | null = null;
  let title: string;

  if (dir === undefined) {
    // One of the four single-file concepts; the format names the file, not the user.
    const base = Object.keys(ROOT_CONCEPT_FILES).find((file) => ROOT_CONCEPT_FILES[file] === type);
    if (base === undefined) throw new Error(`no home is defined for ${type}`);
    if (name) {
      throw new Error(
        `${type} is one file per record — \`forge add ${entry.keys[0]}\` takes no name`,
      );
    }
    relPath = path.join(recordRoot, base);
    title = type;
  } else {
    const given = (name ?? "").trim();
    if (given === "") {
      throw new Error(`\`forge add ${entry.keys[0]}\` needs ${entry.names ?? "a name"}`);
    }
    const slug = slugify(given);
    if (slug === "") {
      throw new Error(`"${given}" has no letters or digits to make a filename from`);
    }
    title = given;
    const prefix = ID_BEARING_TYPES[type];
    if (prefix) {
      id = nextId(
        bundle.concepts.flatMap((c) => (c.type === type && c.id ? [c.id] : [])),
        prefix,
      );
      // The filename is the bare id for every id-bearing type *except* a
      // decision, which keeps a slug suffix (spec §4, enforced by `checkId`).
      // Writing `ROLE-001-contract-development-manager.md` looks friendlier and
      // fails doctor immediately — caught by running this against a real record
      // rather than by reading the rule.
      relPath = path.join(recordRoot, dir, `${id}.md`);
    } else {
      relPath = path.join(recordRoot, dir, `${slug}.md`);
    }
  }

  // Never overwrite. `forge init` established that a record command adds and
  // reports rather than replacing what someone wrote.
  const absolute = path.join(root, relPath);
  try {
    await fs.access(absolute);
    throw new Error(`${relPath} already exists — nothing was written`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const domainStatus = DOMAIN_STATUS_FIELDS[type];
  const contents = withFrontmatter(
    {
      type,
      ...(id ? { id } : {}),
      title,
      date: todayIsoDate(),
      ...(domainStatus ? { [domainStatus.field]: domainStatus.values[0] } : {}),
    },
    starterBody(entry),
  );

  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, contents, "utf8");
  // The writer that adds a concept is the one that keeps the index true (T-300).
  await writeBundleIndex(root);

  return { type, path: relPath, id };
}
