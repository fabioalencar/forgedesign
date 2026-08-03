import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDraftScenario,
  discardDraftScenario,
  generateScenarioId,
  getSavedScenario,
  listDraftScenarios,
  listSavedScenarios,
  parseScenario,
  readDraftScenario,
  saveScenario,
  serializeScenario,
  updateSavedScenario,
} from "../src/scenarios.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-scenarios-"));
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const root = path.join(sandbox, "repo");
  await fs.mkdir(root, { recursive: true });
  return root;
}

describe("generateScenarioId", () => {
  it("produces distinct scn-<8 lowercase base32 chars> ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateScenarioId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^scn-[0-9a-hjkmnp-tv-z]{8}$/);
  });
});

describe("scenario markdown round-trip", () => {
  it("serializes and reparses a scenario with controls and an expected outcome", () => {
    const scenario = {
      frontmatter: {
        type: "scenario" as const,
        id: "scn-7k2m9p4x",
        version: 3,
        title: "Susan reviews an incomplete proposal",
        actor: "Susan Reyes (legal reviewer)",
        role: "reviewer",
        route: "/proposals/prp-1042",
        viewport: "1280x800",
        controls: {
          "global.user": "usr-susan",
          "global.readOnly": true,
          "local.proposal-detail.completeness": "partial",
        },
        declarations: ".forge/scenario-decls/scn-7k2m9p4x@3.json",
      },
      purpose: "Susan needs to see which sections block approval without opening each one.",
      expectedOutcome:
        "the completeness banner names the two missing sections and the approve action is disabled with an explanation.",
    };
    const serialized = serializeScenario(scenario);
    expect(serialized).toContain("global.user: usr-susan");
    expect(serialized).toContain("global.readOnly: true");
    expect(parseScenario(serialized)).toEqual(scenario);
  });

  it("rejects a file missing frontmatter or required fields", () => {
    expect(parseScenario("no frontmatter here")).toBeNull();
    expect(parseScenario("---\ntype: scenario\n---\nbody")).toBeNull();
  });

  it("ignores unknown frontmatter fields the same way patterns.ts does", () => {
    const source = [
      "---",
      "type: scenario",
      "id: scn-aaaaaaaa",
      "version: 1",
      "title: Minimal scenario",
      "unexpected: value",
      "---",
      "purpose only",
    ].join("\n");
    const parsed = parseScenario(source);
    expect(parsed?.frontmatter.title).toBe("Minimal scenario");
    expect(parsed?.purpose).toBe("purpose only");
  });
});

describe("Draft lifecycle", () => {
  it("stages a draft under .forge/scenarios/ without touching scenarios/", async () => {
    const root = await repo();
    const draft = await createDraftScenario({
      cwd: root,
      title: "Susan reviews an incomplete proposal",
      dataset: "ds-4qn8w2vt@2",
      controls: { "global.user": "usr-susan" },
      purpose: "See the gap.",
    });
    expect(draft.id).toMatch(/^scn-/);
    expect(draft.frontmatter.version).toBe(1);
    expect(draft.frontmatter.dataset).toBe("ds-4qn8w2vt@2");
    await expect(fs.access(path.join(root, "scenarios"))).rejects.toThrow();
    const staged = await fs.readFile(path.join(root, ".forge/scenarios", `${draft.id}.md`), "utf8");
    expect(staged).toContain("global.user: usr-susan");
    expect(staged).toContain("dataset: ds-4qn8w2vt@2");

    const reread = await readDraftScenario(draft.id, root);
    expect(reread.frontmatter.title).toBe(draft.frontmatter.title);

    const listed = await listDraftScenarios(root);
    expect(listed.map((d) => d.id)).toEqual([draft.id]);

    await discardDraftScenario(draft.id, root);
    expect(await listDraftScenarios(root)).toEqual([]);
  });

  it("lists no drafts when .forge/scenarios/ does not exist yet", async () => {
    const root = await repo();
    expect(await listDraftScenarios(root)).toEqual([]);
  });

  it("carries the declaration snapshot captured at Draft time through to discard", async () => {
    const root = await repo();
    const declarations = [{ id: "global.user", kind: "string", label: "Current user" }];
    const draft = await createDraftScenario({
      cwd: root,
      title: "Has declarations",
      controls: {},
      purpose: "x",
      declarations,
    });
    await expect(
      fs.access(path.join(root, ".forge/scenarios", `${draft.id}.decls.json`)),
    ).resolves.toBeUndefined();
    await discardDraftScenario(draft.id, root);
    await expect(
      fs.access(path.join(root, ".forge/scenarios", `${draft.id}.decls.json`)),
    ).rejects.toThrow();
  });
});

describe("Draft → Saved", () => {
  it("promotes a draft into scenarios/, writes its declaration snapshot, and removes the draft", async () => {
    const root = await repo();
    const draft = await createDraftScenario({
      cwd: root,
      title: "Susan reviews an incomplete proposal!",
      controls: { "global.user": "usr-susan" },
      purpose: "See the gap.",
    });

    const snapshot = [{ id: "global.user", kind: "string", label: "Current user" }];
    const saved = await saveScenario(draft.id, snapshot, root);

    expect(saved.slug).toBe("susan-reviews-an-incomplete-proposal");
    expect(saved.frontmatter.declarations).toBe(
      `.forge/scenario-decls/${draft.frontmatter.id}@1.json`,
    );
    await expect(
      fs.access(path.join(root, ".forge/scenarios", `${draft.id}.md`)),
    ).rejects.toThrow();

    const savedFile = await fs.readFile(path.join(root, saved.path), "utf8");
    expect(savedFile).toContain("global.user: usr-susan");

    const decl = JSON.parse(
      await fs.readFile(path.join(root, saved.frontmatter.declarations!), "utf8"),
    );
    expect(decl).toEqual(snapshot);

    const listed = await listSavedScenarios(root);
    expect(listed.map((s) => s.slug)).toEqual(["susan-reviews-an-incomplete-proposal"]);
    expect(await getSavedScenario("susan-reviews-an-incomplete-proposal", root)).toMatchObject({
      slug: saved.slug,
    });
    expect(await getSavedScenario("no-such-scenario", root)).toBeNull();
  });

  it("falls back to the declaration snapshot captured at Draft time when Save omits one", async () => {
    const root = await repo();
    const declarations = [{ id: "global.user", kind: "string", label: "Current user" }];
    const draft = await createDraftScenario({
      cwd: root,
      title: "Captured at draft time",
      controls: { "global.user": "usr-susan" },
      purpose: "x",
      declarations,
    });
    const saved = await saveScenario(draft.id, undefined, root);
    const decl = JSON.parse(
      await fs.readFile(path.join(root, saved.frontmatter.declarations!), "utf8"),
    );
    expect(decl).toEqual(declarations);
  });

  it("writes an empty declaration snapshot when neither Save nor Draft supplied one", async () => {
    const root = await repo();
    const draft = await createDraftScenario({
      cwd: root,
      title: "No declarations captured",
      controls: {},
      purpose: "x",
    });
    const saved = await saveScenario(draft.id, undefined, root);
    const decl = JSON.parse(
      await fs.readFile(path.join(root, saved.frontmatter.declarations!), "utf8"),
    );
    expect(decl).toEqual([]);
  });

  it("disambiguates a slug collision between two same-titled scenarios", async () => {
    const root = await repo();
    const first = await createDraftScenario({
      cwd: root,
      title: "Empty state",
      controls: {},
      purpose: "a",
    });
    const second = await createDraftScenario({
      cwd: root,
      title: "Empty state",
      controls: {},
      purpose: "b",
    });
    const savedFirst = await saveScenario(first.id, [], root);
    const savedSecond = await saveScenario(second.id, [], root);
    expect(savedFirst.slug).toBe("empty-state");
    expect(savedSecond.slug).toBe("empty-state-2");
  });
});

describe("Saved scenario versioning (DDR-045)", () => {
  it("bumps the version and writes a new snapshot without deleting the previous one", async () => {
    const root = await repo();
    const draft = await createDraftScenario({
      cwd: root,
      title: "Proposal review",
      controls: { "global.user": "usr-susan" },
      purpose: "original purpose",
    });
    const saved = await saveScenario(
      draft.id,
      [{ id: "global.user", kind: "string", label: "Current user" }],
      root,
    );
    expect(saved.frontmatter.version).toBe(1);
    const oldSnapshotPath = saved.frontmatter.declarations!;

    const updated = await updateSavedScenario(
      saved.slug,
      { controls: { "global.user": "usr-marco" }, purpose: "updated purpose" },
      [{ id: "global.user", kind: "string", label: "Current user" }],
      root,
    );

    expect(updated.frontmatter.version).toBe(2);
    expect(updated.frontmatter.controls["global.user"]).toBe("usr-marco");
    expect(updated.purpose).toBe("updated purpose");
    // the version-1 snapshot must still exist and be untouched
    await expect(fs.access(path.join(root, oldSnapshotPath))).resolves.toBeUndefined();
    expect(updated.frontmatter.declarations).not.toBe(oldSnapshotPath);

    const reread = await getSavedScenario(saved.slug, root);
    expect(reread?.frontmatter.version).toBe(2);
  });
});
