import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installAgentsAdapter, installSkills, SKILL_MARKER, skillFiles } from "../src/skills.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "forge-skills-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const read = (relPath: string) => fs.readFile(path.join(root, relPath), "utf8");

describe("skillFiles", () => {
  it("carries the skills, and only the skills", () => {
    const names = Object.keys(skillFiles());
    expect(names).toContain("triage/SKILL.md");
    expect(names).toContain("forge-init/SKILL.md");
    // README and the Codex adapter ship in the package but are not skills
    expect(names.some((name) => name.startsWith("README"))).toBe(false);
    expect(names.some((name) => name.startsWith("AGENTS"))).toBe(false);
  });
});

describe("installSkills", () => {
  it("writes every skill into .claude/skills/, marked as ours", async () => {
    const result = await installSkills(root);
    expect(result.files.every((file) => file.outcome === "written")).toBe(true);
    expect(result.conflicts).toEqual([]);

    const triage = await read(".claude/skills/triage/SKILL.md");
    expect(triage).toContain(SKILL_MARKER);
    expect(triage).toContain("forge comments triage apply");
  });

  it("replaces its own earlier output, so skills track the CLI they call", async () => {
    await installSkills(root);
    const target = path.join(root, ".claude/skills/triage/SKILL.md");
    await fs.writeFile(target, `${SKILL_MARKER}\nstale from an older version\n`, "utf8");

    const result = await installSkills(root);
    expect(result.files.find((f) => f.relPath.includes("triage"))?.outcome).toBe("updated");
    expect(await read(".claude/skills/triage/SKILL.md")).not.toContain("stale from an older");
  });

  it("never touches a skill it did not write", async () => {
    // `triage` and `freeze` are generic enough that a user may already have
    // their own — replacing one silently is the worst way to find that out.
    const target = path.join(root, ".claude/skills/triage/SKILL.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "# my own triage skill\n", "utf8");

    const result = await installSkills(root);
    expect(result.conflicts).toEqual([".claude/skills/triage/SKILL.md"]);
    expect(await read(".claude/skills/triage/SKILL.md")).toBe("# my own triage skill\n");
    // the rest still install
    expect(result.files.filter((f) => f.outcome === "written").length).toBeGreaterThan(0);
  });

  it("is idempotent — a second run changes nothing", async () => {
    await installSkills(root);
    const again = await installSkills(root);
    expect(again.files.every((file) => file.outcome === "kept")).toBe(true);
  });
});

describe("installAgentsAdapter", () => {
  it("writes the Codex adapter when there is none", async () => {
    const result = await installAgentsAdapter(root);
    expect(result.outcome).toBe("written");
    expect(await read("AGENTS.md")).toContain("Codex");
  });

  it("refuses to replace a repo's own AGENTS.md", async () => {
    // A root AGENTS.md is conventionally the project's instructions to its
    // agents — this command has no business overwriting one.
    await fs.writeFile(path.join(root, "AGENTS.md"), "# our house rules\n", "utf8");
    const result = await installAgentsAdapter(root);
    expect(result.outcome).toBe("kept");
    expect(await read("AGENTS.md")).toBe("# our house rules\n");
  });

  it("updates the adapter it wrote itself", async () => {
    await installAgentsAdapter(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), `${SKILL_MARKER}\nold\n`, "utf8");
    expect((await installAgentsAdapter(root)).outcome).toBe("updated");
  });
});
