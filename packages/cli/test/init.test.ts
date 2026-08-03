import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coreScaffold, parseConcept, parseTodos, TASK_SECTIONS } from "@forgedesign/format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "../src/commands/init.js";
import { runDoctor } from "../src/doctor.js";
import { readRegistry } from "../src/registry.js";

let sandbox: string;
let previousForgeHome: string | undefined;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-init-"));
  previousForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = path.join(sandbox, ".forge");
});

afterEach(async () => {
  if (previousForgeHome === undefined) {
    delete process.env.FORGE_HOME;
  } else {
    process.env.FORGE_HOME = previousForgeHome;
  }
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("initProject", () => {
  it("creates the core file set and nothing else (spec §2, progressive scaffolding)", async () => {
    const root = path.join(sandbox, "acme-app");

    const result = await initProject(root);

    // v0.2 scaffolds an OKF bundle. A glossary and open questions are
    // directories of concepts now, so they appear with their first concept
    // rather than as empty templates (spec §1 principle 3).
    expect(result.written.sort()).toEqual(
      [
        "design/index.md",
        "design/brief.md",
        "design/todos.md",
        "design/decisions/DDR-000-template.md",
        "forge.json",
      ].sort(),
    );
    for (const file of Object.keys(coreScaffold())) {
      await expect(fs.access(path.join(root, file))).resolves.toBeUndefined();
    }

    // The pre-pivot scaffold is gone: no build tool, no design-system starter,
    // no artifact-type folders (DDR-050).
    for (const gone of ["prototype", "tokens", "artifacts", "context", "todo", "skills"]) {
      await expect(fs.access(path.join(root, gone))).rejects.toThrow();
    }
    await expect(fs.access(path.join(root, "CLAUDE.md"))).rejects.toThrow();
  });

  it("stamps forge.json with the current formatVersion and nothing else", async () => {
    const root = path.join(sandbox, "versioned");
    await initProject(root);

    const manifest = JSON.parse(await fs.readFile(path.join(root, "forge.json"), "utf8"));
    expect(manifest).toEqual({ formatVersion: "0.2", recordRoot: "design" });
  });

  it("writes a Todos.md the format's own parser reads as empty, not malformed", async () => {
    const root = path.join(sandbox, "todos");
    await initProject(root);

    const text = await fs.readFile(path.join(root, "design/todos.md"), "utf8");
    // The ledger lives in the concept's body; its frontmatter must be valid too.
    expect(parseConcept("todos.md", text).problems).toEqual([]);
    const doc = parseTodos(parseConcept("todos.md", text).body);
    expect(doc.sections.map((section) => section.heading)).toEqual([...TASK_SECTIONS]);
    // every canonical section present, and not one task pretending to exist
    expect(
      doc.sections.flatMap((section) => section.blocks).filter((b) => b.kind === "entry"),
    ).toEqual([]);
  });

  it("produces a record that forge doctor accepts", async () => {
    const root = path.join(sandbox, "clean");
    await initProject(root);

    expect(await runDoctor(root)).toMatchObject({ findings: [], exitCode: 0 });
  });

  it("ignores .forge/ so runtime state never lands in the user's history", async () => {
    const root = path.join(sandbox, "ignored");

    const result = await initProject(root);

    expect(result.gitIgnoreUpdated).toBe(true);
    expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toContain(".forge/");
  });

  it("appends to an existing .gitignore, and does not duplicate the rule", async () => {
    const root = path.join(sandbox, "existing-ignore");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\n", "utf8");

    const first = await initProject(root);
    expect(first.gitIgnoreUpdated).toBe(true);
    expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.forge/\n",
    );

    const second = await initProject(root);
    expect(second.gitIgnoreUpdated).toBe(false);
    expect(await fs.readFile(path.join(root, ".gitignore"), "utf8")).toBe(
      "node_modules/\n.forge/\n",
    );
  });

  it("refuses to claim it kept a file that is only a case-variant", async () => {
    // Before this, init reported "kept existing: Todos.md" for a repo holding a
    // hand-written TODOS.md — the same fs.access blind spot T-255 fixed in
    // upgrade and the record scanner.
    const root = path.join(sandbox, "collision");
    await fs.mkdir(path.join(root, "design"), { recursive: true });
    await fs.writeFile(path.join(root, "design/TODOS.md"), "# TODOs\n\nhand-written\n", "utf8");

    const result = await initProject(root);

    expect(result.blocked).toEqual([{ target: "design/todos.md", variant: "TODOS.md" }]);
    expect(result.skipped).not.toContain("design/todos.md");
    expect(result.written).not.toContain("design/todos.md");
    expect(result.written).toContain("design/brief.md");
    expect(await fs.readFile(path.join(root, "design/TODOS.md"), "utf8")).toContain("hand-written");
  });

  it("initializes a Git repository when there isn't one", async () => {
    const root = path.join(sandbox, "fresh");
    const result = await initProject(root);

    expect(result.gitInitialized).toBe(true);
    await expect(fs.access(path.join(root, ".git"))).resolves.toBeUndefined();
  });

  it("registers the project in FORGE_HOME/projects.json", async () => {
    const root = path.join(sandbox, "registered");
    await initProject(root);

    const registry = await readRegistry();
    expect(registry.projects).toEqual([
      expect.objectContaining({ name: "registered", path: root }),
    ]);
  });

  it("adopts a repo with real content: nothing is overwritten, nothing is duplicated", async () => {
    // The normal case post-DDR-050 — an existing project takes on the record.
    const root = path.join(sandbox, "adopted");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src/index.ts"), "export const x = 1;\n", "utf8");
    await fs.mkdir(path.join(root, "design"), { recursive: true });
    await fs.writeFile(
      path.join(root, "design/brief.md"),
      "---\ntype: Brief\n---\nAlready written.\n",
      "utf8",
    );
    execFileSync("git", ["init", "-q"], { cwd: root });

    const result = await initProject(root);

    expect(result.skipped).toContain("design/brief.md");
    expect(result.written).toContain("design/todos.md");
    expect(result.gitInitialized).toBe(false);
    expect(await fs.readFile(path.join(root, "design/brief.md"), "utf8")).toContain(
      "Already written.",
    );
    expect(await fs.readFile(path.join(root, "src/index.ts"), "utf8")).toBe(
      "export const x = 1;\n",
    );

    const second = await initProject(root);
    expect(second.written).toEqual([]);
    expect(second.skipped.sort()).toEqual(result.written.concat(result.skipped).sort());
    expect((await readRegistry()).projects.filter((p) => p.name === "adopted")).toHaveLength(1);
  });
});
