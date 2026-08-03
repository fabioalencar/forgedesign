import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRecord } from "../src/record.js";

describe("scanRecord", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "forge-format-record-"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("returns an empty record when nothing exists yet", async () => {
    const record = await scanRecord(root);
    expect(record.files).toEqual({});
    expect(record.decisions).toEqual([]);
  });

  it("reads only the files that exist (progressive scaffolding)", async () => {
    await fs.writeFile(path.join(root, "Brief.md"), "# Brief\n", "utf8");
    await fs.writeFile(path.join(root, "Todos.md"), "## Todo\n", "utf8");

    const record = await scanRecord(root);
    expect(Object.keys(record.files).sort()).toEqual(["Brief.md", "Todos.md"]);
    expect(record.files["Brief.md"]?.text).toBe("# Brief\n");
  });

  it("refuses a differently-cased file and reports the collision instead", async () => {
    // On APFS/NTFS, reading "Todos.md" here returns THIS file's bytes — the
    // record would look valid and empty. Portable on Linux too: the exact-cased
    // name is still absent, so it is still a collision.
    await fs.writeFile(path.join(root, "TODOS.md"), "# TODOs\n\nhand-written\n", "utf8");
    await fs.writeFile(path.join(root, "Brief.md"), "# Brief\n", "utf8");

    const record = await scanRecord(root);

    expect(Object.keys(record.files)).toEqual(["Brief.md"]);
    expect(record.caseCollisions).toEqual([{ expected: "Todos.md", found: "TODOS.md" }]);
  });

  it("reports no collision when the exact-cased file is the one on disk", async () => {
    await fs.writeFile(path.join(root, "Todos.md"), "## Todo\n", "utf8");

    const record = await scanRecord(root);

    expect(record.caseCollisions).toEqual([]);
    expect(record.files["Todos.md"]?.text).toBe("## Todo\n");
  });

  it("reads every decisions/*.md file, sorted by filename", async () => {
    await fs.mkdir(path.join(root, "decisions"));
    await fs.writeFile(path.join(root, "decisions", "DDR-002-slug.md"), "b", "utf8");
    await fs.writeFile(path.join(root, "decisions", "DDR-001-slug.md"), "a", "utf8");
    await fs.writeFile(path.join(root, "decisions", "DDR-000-template.md"), "t", "utf8");

    const record = await scanRecord(root);
    expect(record.decisions.map((d) => d.filename)).toEqual([
      "DDR-000-template.md",
      "DDR-001-slug.md",
      "DDR-002-slug.md",
    ]);
  });
});
