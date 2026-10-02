import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  installAgentsAdapter,
  installHomeSkills,
  installSkills,
  SKILL_MARKER,
  skillFiles,
} from "../src/skills.js";

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
    expect(names).toContain("forge-triage/SKILL.md");
    expect(names).toContain("forge-init/SKILL.md");
    // README and the Codex adapter ship in the package but are not skills
    expect(names.some((name) => name.startsWith("README"))).toBe(false);
    expect(names.some((name) => name.startsWith("AGENTS"))).toBe(false);
  });

  it("names every skill forge-*, in its directory and its frontmatter", () => {
    // An agent's skills directory is shared with every other suite the
    // designer runs; `freeze`, `review` and `triage` were already taken (DDR-136).
    for (const [relPath, body] of Object.entries(skillFiles())) {
      const name = relPath.replace("/SKILL.md", "");
      expect(name).toMatch(/^forge-/);
      expect(body).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
    }
  });
});

describe("installSkills", () => {
  it("writes every skill into .claude/skills/, marked as ours", async () => {
    const result = await installSkills(root);
    expect(result.files.every((file) => file.outcome === "written")).toBe(true);
    expect(result.conflicts).toEqual([]);

    const triage = await read(".claude/skills/forge-triage/SKILL.md");
    expect(triage).toContain(SKILL_MARKER);
    expect(triage).toContain("forge comments triage apply");
  });

  it("replaces its own earlier output, so skills track the CLI they call", async () => {
    await installSkills(root);
    const target = path.join(root, ".claude/skills/forge-triage/SKILL.md");
    await fs.writeFile(target, `${SKILL_MARKER}\nstale from an older version\n`, "utf8");

    const result = await installSkills(root);
    expect(result.files.find((f) => f.relPath.includes("forge-triage"))?.outcome).toBe("updated");
    expect(await read(".claude/skills/forge-triage/SKILL.md")).not.toContain("stale from an older");
  });

  it("never touches a skill it did not write", async () => {
    // `triage` and `freeze` are generic enough that a user may already have
    // their own — replacing one silently is the worst way to find that out.
    const target = path.join(root, ".claude/skills/forge-triage/SKILL.md");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "# my own triage skill\n", "utf8");

    const result = await installSkills(root);
    expect(result.conflicts).toEqual([".claude/skills/forge-triage/SKILL.md"]);
    expect(await read(".claude/skills/forge-triage/SKILL.md")).toBe("# my own triage skill\n");
    // the rest still install
    expect(result.files.filter((f) => f.outcome === "written").length).toBeGreaterThan(0);
  });

  it("is idempotent — a second run changes nothing", async () => {
    await installSkills(root);
    const again = await installSkills(root);
    expect(again.files.every((file) => file.outcome === "kept")).toBe(true);
    expect(again.removed).toEqual([]);
  });

  it("sweeps its own install under a pre-forge-* name, and only its own", async () => {
    const ours = path.join(root, ".claude/skills/ddr/SKILL.md");
    const theirs = path.join(root, ".claude/skills/triage/SKILL.md");
    await fs.mkdir(path.dirname(ours), { recursive: true });
    await fs.mkdir(path.dirname(theirs), { recursive: true });
    await fs.writeFile(ours, `${SKILL_MARKER}\n---\nname: ddr\n---\n`, "utf8");
    await fs.writeFile(theirs, "# an issue-tracker triage skill\n", "utf8");

    const result = await installSkills(root);
    expect(result.removed).toEqual([".claude/skills/ddr/SKILL.md"]);
    await expect(fs.access(path.dirname(ours))).rejects.toThrow();
    expect(await read(".claude/skills/triage/SKILL.md")).toBe("# an issue-tracker triage skill\n");
  });
});

describe("installHomeSkills", () => {
  const home = () => path.join(root, "home");
  const forgeHome = () => path.join(root, "home", ".forge");
  const claude = (name: string) => path.join(home(), ".claude/skills", name);
  const agents = (name: string) => path.join(home(), ".agents/skills", name);

  it("writes the skills once and links both agents' directories to them", async () => {
    const result = await installHomeSkills({ home: home(), forgeHome: forgeHome() });
    expect(result.store).toBe(path.join(forgeHome(), "skills"));
    expect(result.conflicts).toEqual([]);

    const store = path.join(forgeHome(), "skills", "forge-triage");
    expect(await fs.readlink(claude("forge-triage"))).toBe(store);
    expect(await fs.readlink(agents("forge-triage"))).toBe(store);
    const body = await fs.readFile(path.join(claude("forge-triage"), "SKILL.md"), "utf8");
    expect(body).toContain(SKILL_MARKER);
    expect(result.links).toHaveLength(Object.keys(skillFiles()).length * 2);
  });

  it("is idempotent — a second run keeps every link", async () => {
    await installHomeSkills({ home: home(), forgeHome: forgeHome() });
    const again = await installHomeSkills({ home: home(), forgeHome: forgeHome() });
    expect(again.links.every((link) => link.outcome === "kept")).toBe(true);
  });

  it("links straight to a checkout with source, so edits there are live", async () => {
    const source = path.join(root, "checkout", "skills");
    for (const relPath of Object.keys(skillFiles())) {
      await fs.mkdir(path.join(source, path.dirname(relPath)), { recursive: true });
      await fs.writeFile(path.join(source, relPath), "---\n", "utf8");
    }
    const result = await installHomeSkills({ home: home(), forgeHome: forgeHome(), source });
    expect(result.store).toBeNull();
    expect(await fs.readlink(claude("forge-ddr"))).toBe(path.join(source, "forge-ddr"));
    await expect(fs.access(path.join(forgeHome(), "skills"))).rejects.toThrow();
  });

  it("refuses a source that is not a skills/ directory", async () => {
    await expect(
      installHomeSkills({ home: home(), forgeHome: forgeHome(), source: root }),
    ).rejects.toThrow(/has no forge-/);
  });

  it("repoints a link and replaces a copy it made, and keeps anything else", async () => {
    await fs.mkdir(path.join(home(), ".claude/skills"), { recursive: true });
    await fs.symlink(path.join(root, "elsewhere"), claude("forge-ddr"));
    await fs.mkdir(claude("forge-freeze"));
    await fs.writeFile(path.join(claude("forge-freeze"), "SKILL.md"), `${SKILL_MARKER}\nold\n`);
    await fs.mkdir(claude("forge-review"));
    await fs.writeFile(path.join(claude("forge-review"), "SKILL.md"), "# hand-made copy\n");

    const result = await installHomeSkills({ home: home(), forgeHome: forgeHome() });
    const outcome = (entry: string) => result.links.find((link) => link.path === entry)?.outcome;
    expect(outcome(claude("forge-ddr"))).toBe("relinked");
    expect(outcome(claude("forge-freeze"))).toBe("relinked");
    expect(result.conflicts).toEqual([claude("forge-review")]);
    expect(await fs.readFile(path.join(claude("forge-review"), "SKILL.md"), "utf8")).toBe(
      "# hand-made copy\n",
    );
  });

  it("sweeps a dangling link to a skill's old name, and leaves another suite's", async () => {
    await fs.mkdir(path.join(home(), ".claude/skills"), { recursive: true });
    const gone = path.join(root, "checkout", "skills", "ddr");
    await fs.symlink(gone, claude("ddr"));
    const live = path.join(root, "suite", "skills", "triage");
    await fs.mkdir(live, { recursive: true });
    await fs.symlink(live, claude("triage"));

    const result = await installHomeSkills({ home: home(), forgeHome: forgeHome() });
    expect(result.removed).toEqual([claude("ddr")]);
    expect(await fs.readlink(claude("triage"))).toBe(live);
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
