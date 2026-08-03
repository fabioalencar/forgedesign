// `forge doctor`'s dispatch (DDR-095).
//
// This file used to hold the v0.1 rule set — seven rules over the root file
// set, all deleted with the format they served. The rules that remain are in
// doctor-v02.test.ts; what is left here is the decision doctor makes *before*
// any rule runs, which is the part DDR-095 changed and the part that has to
// tell four kinds of "this is not a current record" apart.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "forge-doctor-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

describe("not a record at all (exit 2)", () => {
  it("flags a missing forge.json and points at init, not upgrade", async () => {
    const result = await runDoctor(root);
    expect(result.exitCode).toBe(2);
    expect(result.findings[0]?.rule).toBe("unparseable");
    expect(result.findings[0]?.message).toContain("forge init");
    expect(result.findings[0]?.message).not.toContain("forge upgrade");
  });

  it("names no file for a finding whose subject is a file that is not there", async () => {
    const result = await runDoctor(root);
    expect(result.findings[0]?.file).toBeUndefined();
  });

  it("flags a malformed forge.json", async () => {
    await write("forge.json", "{not json");
    const result = await runDoctor(root);
    expect(result.exitCode).toBe(2);
    expect(result.findings[0]?.rule).toBe("unparseable");
  });
});

describe("a record that is behind (exit 1, one finding)", () => {
  it("answers a v0.1 record with `forge upgrade` and nothing else", async () => {
    await write("forge.json", JSON.stringify({ formatVersion: "0.1" }));
    // Deliberately invalid under the old rules: a duplicate id and a bogus
    // status. Neither is reported, because those rules no longer exist — the
    // record's format is the only thing wrong with it that doctor still knows
    // how to say.
    await write("Brief.md", "# Brief\n");
    await write(
      "Todos.md",
      "# Todos\n\n## Todo\n- [ ] TASK-001 One\n  status: nonsense\n- [ ] TASK-001 Two\n  status: todo\n",
    );

    const result = await runDoctor(root);
    expect(result.exitCode).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.rule).toBe("format-version");
    expect(result.findings[0]?.message).toContain("forge upgrade --to 0.2");
  });

  it("treats a pre-0.1 repo with no manifest as migratable, not as an empty directory", async () => {
    // The sharp edge DDR-095 names: a v1 record never had a forge.json, so
    // "no manifest" cannot mean "not a record". Getting this backwards sends
    // someone to `forge init` on top of a record they already have.
    await write("todo/todo.md", "# Todo\n\n## Inbox\n- [ ] T-001 Something\n");

    const result = await runDoctor(root);
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.rule).toBe("format-version");
    expect(result.findings[0]?.message).toContain("forge upgrade");
  });

  it("does not tell a record from a newer Forge to migrate backwards", async () => {
    await write("forge.json", JSON.stringify({ formatVersion: "9.9" }));

    const result = await runDoctor(root);
    expect(result.exitCode).toBe(1);
    expect(result.findings[0]?.rule).toBe("format-version");
    expect(result.findings[0]?.message).toContain("newer Forge");
    expect(result.findings[0]?.message).not.toContain("forge upgrade");
  });
});

describe("a current record", () => {
  it("runs the v0.2 rules and reports a conformant bundle clean", async () => {
    await write(
      "forge.json",
      JSON.stringify({ formatVersion: "0.2", recordRoot: "design" }, null, 2),
    );
    await write("design/index.md", '---\nokf_version: "0.2"\n---\n# The record\n');
    await write("design/brief.md", "---\ntype: Brief\ntitle: Brief\n---\nGenesis.\n");
    await write(
      "design/todos.md",
      "---\ntype: Task Ledger\ntitle: Todos\n---\n## Todo\n- [ ] TASK-001 Do it\n  status: todo\n",
    );

    const result = await runDoctor(root);
    expect(result.exitCode).toBe(0);
    expect(result.findings).toEqual([]);
  });
});
