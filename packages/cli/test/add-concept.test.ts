// `forge add <concept>` (TASK-391, DDR-103).
//
// The properties worth pinning are the ones that would silently rot: that the
// catalogue covers every type the format has, that what it writes passes
// `forge doctor` (the first version did not — two of these tests exist because
// running it against a real record failed), and that it refuses rather than
// writes for the concepts another command owns.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONCEPT_TYPES, parseConcept } from "@forgedesign/format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addableTypes,
  addConcept,
  CONCEPT_CATALOGUE,
  resolveConcept,
  slugify,
} from "../src/add-concept.js";
import { initProject } from "../src/commands/init.js";

let sandbox: string;
let repo: string;
let previousForgeHome: string | undefined;

beforeEach(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "forge-add-")));
  previousForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = path.join(sandbox, ".forge");
  repo = path.join(sandbox, "repo");
  await initProject(repo);
});

afterEach(async () => {
  if (previousForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = previousForgeHome;
  await fs.rm(sandbox, { recursive: true, force: true });
});

const read = (rel: string) => fs.readFile(path.join(repo, rel), "utf8");

describe("the catalogue", () => {
  it("describes every type the format declares", () => {
    // The drift guard. `CONCEPT_CATALOGUE` is a Record<ConceptType, …> so this
    // is already a compile error, but the assertion states the intent for a
    // reader and fails loudly if the typing is ever loosened.
    expect(Object.keys(CONCEPT_CATALOGUE).sort()).toEqual([...CONCEPT_TYPES].sort());
  });

  it("offers the on-demand set and defers the rest to their own writers", () => {
    expect(addableTypes()).toEqual([
      "Term",
      "Story",
      "Role",
      "Stakeholder",
      "Flow",
      "Scenario",
      "Calendar",
      "Data Model",
      "Design System",
      "Component Inventory",
    ]);
    expect(CONCEPT_CATALOGUE.Decision.writtenBy).toBe("forge ddr apply");
  });

  it("takes the singular or the directory name, because guessing wrong is the failure", () => {
    expect(resolveConcept("role")).toBe("Role");
    expect(resolveConcept("roles")).toBe("Role");
    expect(resolveConcept("Roles")).toBe("Role");
    expect(resolveConcept("glossary")).toBe("Term");
    expect(resolveConcept("data-model")).toBe("Data Model");
    expect(resolveConcept("rolez")).toBeNull();
  });

  it("carries no id citation into guidance, because that guidance lands in someone else's record", () => {
    // The Flow guidance named DDR-056 in the first version. It goes into the
    // file body, so `forge doctor` tried to resolve our decision id inside the
    // user's record and reported an unresolved reference — the TASK-415 defect
    // one layer in.
    for (const entry of Object.values(CONCEPT_CATALOGUE)) {
      expect(entry.guidance ?? "").not.toMatch(/\b[A-Z]+-\d{3}\b/);
    }
  });
});

describe("addConcept", () => {
  it("writes an id-bearing concept the format accepts", async () => {
    const result = await addConcept(repo, "role", "Contract Development Manager");
    // The filename is the bare id — only a decision keeps a slug suffix (spec
    // §4). Writing ROLE-001-contract-development-manager.md reads better and
    // fails doctor immediately.
    expect(result.path).toBe("design/roles/ROLE-001.md");
    expect(result.id).toBe("ROLE-001");

    const concept = parseConcept("roles/ROLE-001.md", await read(result.path));
    expect(concept.problems).toEqual([]);
    expect(concept.type).toBe("Role");
    expect(concept.title).toBe("Contract Development Manager");
  });

  it("allocates the next id from the record's own concepts", async () => {
    await addConcept(repo, "role", "First");
    const second = await addConcept(repo, "roles", "Second");
    expect(second.id).toBe("ROLE-002");
  });

  it("names a term by its slug, since a Term carries no id", async () => {
    const result = await addConcept(repo, "glossary", "Frozen Version");
    expect(result.path).toBe("design/glossary/frozen-version.md");
    expect(result.id).toBeNull();
    expect(await read(result.path)).toContain("title: Frozen Version");
  });

  it("puts a single-file concept where the format says, and takes no name", async () => {
    const result = await addConcept(repo, "data-model");
    expect(result.path).toBe("design/data-model.md");
    await expect(addConcept(repo, "calendar", "Q3")).rejects.toThrow(/takes no name/);
  });

  it("opens the body with a comment rather than placeholder prose", async () => {
    // Spec §1 principle 3: empty templates are rot and agents read rot as
    // truth. A comment renders as nothing anywhere, so the file looks empty to
    // a reader while still saying what belongs in it.
    const result = await addConcept(repo, "flow", "Checkout");
    const body = await read(result.path);
    expect(body).toContain("<!--");
    expect(body.split("---")[2]?.trim().startsWith("<!--")).toBe(true);
  });

  it("keeps the index true, since it is the writer that added the concept", async () => {
    await addConcept(repo, "role", "Reviewer");
    expect(await read("design/index.md")).toContain("roles/ROLE-001.md");
  });

  it("never overwrites", async () => {
    await addConcept(repo, "components");
    await fs.writeFile(path.join(repo, "design/components.md"), "mine\n", "utf8");
    await expect(addConcept(repo, "components")).rejects.toThrow(/already exists/);
    expect(await read("design/components.md")).toBe("mine\n");
  });

  it("refuses the concepts another command owns, naming that command", async () => {
    await expect(addConcept(repo, "ddr", "x")).rejects.toThrow(/forge ddr apply/);
    await expect(addConcept(repo, "question", "x")).rejects.toThrow(/forge question/);
    await expect(addConcept(repo, "feedback", "x")).rejects.toThrow(/forge comments triage apply/);
  });

  it("refuses an unknown concept and a nameless one", async () => {
    await expect(addConcept(repo, "rolez", "x")).rejects.toThrow(/not a concept in this format/);
    await expect(addConcept(repo, "role")).rejects.toThrow(/needs the role's name/);
    await expect(addConcept(repo, "role", "!!!")).rejects.toThrow(/no letters or digits/);
  });

  it("refuses a pre-0.2 record with the sentence naming its way out", async () => {
    const old = path.join(sandbox, "old");
    await fs.mkdir(old, { recursive: true });
    await fs.writeFile(path.join(old, "forge.json"), '{"formatVersion":"0.1"}\n', "utf8");
    await expect(addConcept(old, "role", "x")).rejects.toThrow(/forge upgrade --to 0\.2/);
  });
});

describe("slugify", () => {
  it("folds accents and punctuation into a filename", () => {
    expect(slugify("Contract Development Manager")).toBe("contract-development-manager");
    expect(slugify("Ação — Revisão!")).toBe("acao-revisao");
    expect(slugify("  spaced  out  ")).toBe("spaced-out");
  });
});
