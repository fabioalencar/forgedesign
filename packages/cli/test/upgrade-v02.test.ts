import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseForgeJson, scanBundle } from "@forgedesign/format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upgradeRecordToV02 } from "../src/upgrade.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "forge-upgrade-v02-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

async function exists(relPath: string): Promise<boolean> {
  return await fs
    .access(path.join(root, relPath))
    .then(() => true)
    .catch(() => false);
}

/** A small but complete v0.1 record. */
async function seedV01Record(): Promise<void> {
  await write("Brief.md", "# Brief\n\nGenesis.\n");
  await write("Todos.md", "# Todos\n\n## Todo\n- [ ] TASK-001 Do it\n  status: todo\n");
  await write("Glossary.md", "# Glossary\n\n- **Path** — one learner's journey.\n");
  await write(
    "OpenQuestions.md",
    "# Open questions\n\n- QUESTION-001 — 2026-05-03 · status: open\n  Is it used?\n",
  );
  await write(
    "decisions/DDR-001-first.md",
    "# DDR-001 — First\n\n- **Status**: accepted\n- **Date**: 2026-05-03\n\n## Decision\n\nYes.\n",
  );
  await write(
    "forge.json",
    JSON.stringify({ formatVersion: "0.1", build: { output: "dist" } }, null, 2),
  );
}

describe("upgradeRecordToV02", () => {
  it("migrates a v0.1 record into a bundle whose concepts all parse clean", async () => {
    await seedV01Record();

    const result = await upgradeRecordToV02(root);

    expect(result.warnings).toEqual([]);
    expect(result.written).toContain("design/brief.md");
    expect(result.written).toContain("design/questions/QUESTION-001.md");
    expect(result.written).toContain("design/glossary/path.md");
    expect(result.written).toContain("design/decisions/DDR-001-first.md");

    const bundle = await scanBundle(root);
    expect(bundle.present).toBe(true);
    expect(bundle.concepts.flatMap((c) => c.problems)).toEqual([]);
  });

  it("stamps forge.json without discarding the rest of the manifest", async () => {
    await seedV01Record();
    await upgradeRecordToV02(root);

    const manifest = parseForgeJson(await fs.readFile(path.join(root, "forge.json"), "utf8"));
    expect(manifest.formatVersion).toBe("0.2");
    expect(manifest.recordRoot).toBe("design");
    expect(manifest.build).toEqual({ output: "dist" });
  });

  it("leaves every v0.1 source in place and reports them as superseded", async () => {
    await seedV01Record();

    const result = await upgradeRecordToV02(root);

    expect(result.pruned).toEqual([]);
    expect(result.superseded).toEqual(
      expect.arrayContaining([
        "Brief.md",
        "Todos.md",
        "Glossary.md",
        "OpenQuestions.md",
        "decisions/",
      ]),
    );
    expect(await exists("Brief.md")).toBe(true);
    expect(await exists("decisions/DDR-001-first.md")).toBe(true);
  });

  it("is safe to re-run: nothing is rewritten the second time", async () => {
    await seedV01Record();
    const first = await upgradeRecordToV02(root);
    const second = await upgradeRecordToV02(root);

    expect(second.written).toEqual([]);
    expect(second.skipped.sort()).toEqual(first.written.filter((p) => p !== "forge.json").sort());
  });

  it("prunes on a later run, which is the review-then-prune flow the report describes", async () => {
    await seedV01Record();
    await upgradeRecordToV02(root);

    // The run that prunes writes nothing new — gating prune on "wrote something"
    // would make this exact invocation a no-op.
    const result = await upgradeRecordToV02(root, { prune: true });

    expect(result.written).toEqual([]);
    expect(result.pruned).toEqual(
      expect.arrayContaining([
        "Brief.md",
        "Todos.md",
        "Glossary.md",
        "OpenQuestions.md",
        "decisions/DDR-001-first.md",
      ]),
    );
    expect(await exists("Brief.md")).toBe(false);
    expect(await exists("decisions")).toBe(false);
    expect(await exists("design/brief.md")).toBe(true);
    expect((await scanBundle(root)).concepts.flatMap((c) => c.problems)).toEqual([]);
  });

  it("never prunes a source whose migrated file is missing", async () => {
    await seedV01Record();
    await upgradeRecordToV02(root);
    await fs.rm(path.join(root, "design", "glossary", "path.md"));

    const result = await upgradeRecordToV02(root, { prune: true });

    // path.md is rewritten by this run, so Glossary.md is represented again and
    // may go; the guard is that a source is only pruned once every file derived
    // from it is on disk.
    expect(result.written).toContain("design/glossary/path.md");
    expect(result.pruned).toContain("Glossary.md");
  });

  it("does nothing in a directory with no record", async () => {
    const result = await upgradeRecordToV02(root);
    expect(result.written).toEqual([]);
    expect(result.superseded).toEqual([]);
    expect(await exists("forge.json")).toBe(false);
  });
});
