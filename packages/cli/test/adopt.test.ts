// `forge adopt` (TASK-393).
//
// The property that matters most is the one a test can actually hold: it writes
// nothing. Everything else is classification, and classification by filename is
// allowed to be wrong — which is why the command reports rather than converts.

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify, isSkipped, scanForAdoption } from "../src/adopt.js";
import { initProject } from "../src/commands/init.js";

let sandbox: string;
let repo: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();

async function write(rel: string, text: string): Promise<void> {
  const file = path.join(repo, rel);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}

beforeEach(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "forge-adopt-")));
  repo = path.join(sandbox, "repo");
  await fs.mkdir(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  git("config", "user.email", "t@t.co");
  git("config", "user.name", "T");
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("classify", () => {
  it("routes a decision folder to decisions, with its date the point", () => {
    for (const file of [
      "docs/adr/0007-use-postgres.md",
      "docs/decisions/why-postgres.md",
      "ADR-014.md",
      "rfcs/rfc-002-auth.md",
    ]) {
      expect(classify(file).destination).toBe("decision");
    }
  });

  it("routes the concept-shaped names to concepts", () => {
    expect(classify("docs/glossary.md").next).toContain("forge add term");
    expect(classify("DATA-MODEL.md").next).toContain("forge add data-model");
    expect(classify("docs/design-system.md").next).toContain("forge add design-system");
    expect(classify("docs/components.md").next).toContain("forge add components");
    expect(classify("docs/flows.md").next).toContain("forge add flow");
    expect(classify("docs/personas.md").next).toContain("forge add role");
    expect(classify("TODO.md").next).toContain("forge task add");
  });

  it("routes everything else to history rather than guessing", () => {
    // The fallback has to be the safe one: prose whose home is unknown goes to
    // intake, where a session proposes and a human promotes item by item.
    expect(classify("README.md").destination).toBe("history");
    expect(classify("docs/architecture.md").destination).toBe("history");
    expect(classify("CHANGELOG.md").next).toContain("forge intake");
  });
});

describe("isSkipped", () => {
  it("never looks at the record itself", () => {
    expect(isSkipped("design/brief.md", "design")).toBe(true);
    expect(isSkipped("design", "design")).toBe(true);
    expect(isSkipped("docs/brief.md", "design")).toBe(false);
  });

  it("ignores non-markdown and generated trees", () => {
    expect(isSkipped("src/index.ts", null)).toBe(true);
    expect(isSkipped("node_modules/pkg/README.md", null)).toBe(true);
    expect(isSkipped("dist/docs/x.md", null)).toBe(true);
  });
});

describe("scanForAdoption", () => {
  it("reads history for a decision's date, because the date is most of its meaning", async () => {
    await write("docs/adr/0007-use-postgres.md", "# Use Postgres\n");
    git("add", "-A");
    execFileSync("git", ["commit", "-qm", "adr"], {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: "2024-03-11T10:00:00",
        GIT_COMMITTER_DATE: "2024-03-11T10:00:00",
      },
    });

    const report = await scanForAdoption(repo);
    const adr = report.candidates.find((c) => c.file === "docs/adr/0007-use-postgres.md");
    expect(adr?.destination).toBe("decision");
    expect(adr?.dated).toBe("2024-03-11");
  });

  it("writes nothing — the one guarantee that makes it safe on a repo nobody has read in a year", async () => {
    await write("README.md", "# Acme\n");
    await write("docs/glossary.md", "# Glossary\n");
    git("add", "-A");
    git("commit", "-qm", "docs");
    await initProject(repo);
    git("add", "-A");
    git("commit", "-qm", "init");

    const before = git("status", "--porcelain", "-uall");
    const listing = git("ls-files");
    await scanForAdoption(repo);
    expect(git("status", "--porcelain", "-uall")).toBe(before);
    expect(git("ls-files")).toBe(listing);
  });

  it("excludes the record and honours .gitignore by reading what git tracks", async () => {
    await write("README.md", "# Acme\n");
    await write(".gitignore", "ignored/\n");
    await write("ignored/notes.md", "# not tracked\n");
    await initProject(repo);
    git("add", "-A");
    git("commit", "-qm", "seed");

    const files = (await scanForAdoption(repo)).candidates.map((c) => c.file);
    expect(files).toContain("README.md");
    expect(files.some((f) => f.startsWith("design/"))).toBe(false);
    expect(files).not.toContain("ignored/notes.md");
  });

  it("reports nothing rather than failing on a repo with no documentation", async () => {
    await write("src/index.ts", "export const x = 1;\n");
    git("add", "-A");
    git("commit", "-qm", "code only");
    expect((await scanForAdoption(repo)).candidates).toEqual([]);
  });
});
