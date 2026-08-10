import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureExplore, mergeExplore, startExplore } from "../src/commands/explore.js";
import { initProject } from "../src/commands/init.js";

let sandbox: string;
let repo: string;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();

beforeEach(async () => {
  // realpath: repoRoot() resolves symlinks (macOS /var → /private/var)
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "forge-explore-")));
  repo = path.join(sandbox, "repo");
  await fs.mkdir(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  git("config", "user.email", "t@t.co");
  git("config", "user.name", "T");
  await fs.writeFile(path.join(repo, "README.md"), "seed\n");
  // A promotion DDR is a write into the record, so these tests need one. Before
  // TASK-418 they ran against a bare repo and passed, which is exactly how a
  // command writing outside the bundle went unnoticed: nothing in the fixture
  // had a bundle for it to miss.
  await initProject(repo);
  git("add", "-A");
  git("commit", "-qm", "seed");
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("startExplore", () => {
  it("creates and switches to explore/<name>", async () => {
    const result = await startExplore({ name: "new-nav", cwd: repo });
    expect(result.branch).toBe("explore/new-nav");
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("explore/new-nav");
    expect(result.sketchPath).toBeNull();
  });

  it("--sketch scaffolds sketches/SKETCH.md", async () => {
    const result = await startExplore({ name: "bold-cards", sketch: true, cwd: repo });
    const sketch = await fs.readFile(result.sketchPath!, "utf8");
    expect(sketch).toContain("# Sketch — bold-cards");
    expect(sketch).toContain("## Hypothesis");
    expect(sketch).toContain("## Verdict");
  });

  it("validates names and refuses existing branches", async () => {
    await expect(startExplore({ name: "Bad Name", cwd: repo })).rejects.toThrow(/lowercase slug/);
    await startExplore({ name: "twice", cwd: repo });
    git("checkout", "-q", "main");
    await expect(startExplore({ name: "twice", cwd: repo })).rejects.toThrow(/already exists/);
  });
});

describe("ensureExplore", () => {
  it("creates the branch without switching the caller's checkout", async () => {
    const result = await ensureExplore({ name: "session-nav", cwd: repo });
    expect(result).toEqual({ branch: "explore/session-nav", created: true });
    // The working checkout must be untouched — the preview worktree is the
    // only runtime that ever checks a session branch out (DDR-048).
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
    expect(git("rev-parse", "--verify", "refs/heads/explore/session-nav")).toBeTruthy();
  });

  it("reuses an existing branch as a no-op", async () => {
    await ensureExplore({ name: "session-nav", cwd: repo });
    const again = await ensureExplore({ name: "session-nav", cwd: repo });
    expect(again).toEqual({ branch: "explore/session-nav", created: false });
    expect(git("symbolic-ref", "--short", "HEAD")).toBe("main");
  });

  it("validates names like startExplore does", async () => {
    await expect(ensureExplore({ name: "Bad Name", cwd: repo })).rejects.toThrow(/lowercase slug/);
  });
});

describe("mergeExplore", () => {
  it("merges into main and converts SKETCH.md into a draft DDR inside the record", async () => {
    await startExplore({ name: "bold-cards", sketch: true, cwd: repo });
    await fs.appendFile(path.join(repo, "sketches/SKETCH.md"), "\nVerdict: bold wins.\n");
    git("add", "-A");
    git("commit", "-qm", "sketch work");
    git("checkout", "-q", "main");

    const result = await mergeExplore({ name: "bold-cards", cwd: repo });

    expect(git("log", "-1", "--format=%s")).toBe("Promote explore/bold-cards");
    // Inside the bundle (TASK-418). This used to be `decisions/` at the repo
    // root — outside the record, so doctor and index never saw the decision.
    expect(result.ddrPath).toBe(path.join(repo, "design/decisions/DDR-001-bold-cards.md"));
    const ddr = await fs.readFile(result.ddrPath!, "utf8");
    // A v0.2 concept: frontmatter, and a status the format actually has. The
    // old body was `# DDR-001 — …` with `- **Status**: proposed`, which is not
    // a concept at all — doctor would have refused it the moment it landed
    // somewhere doctor could see.
    expect(ddr).toMatch(/^---\n/);
    expect(ddr).toContain("type: Decision");
    expect(ddr).toContain("id: DDR-001");
    expect(ddr).toContain("decision_status: draft");
    expect(ddr).not.toContain("- **Status**:");
    expect(ddr).toContain("exploration branch explore/bold-cards");
    expect(ddr).toContain("Verdict: bold wins.");
    // left uncommitted for the designer to finish
    expect(git("status", "--porcelain", "-uall")).toContain(
      "design/decisions/DDR-001-bold-cards.md",
    );
    // The writer that adds a concept keeps the index true, or the promotion
    // leaves the record failing doctor's stale-index check.
    expect(await fs.readFile(path.join(repo, "design/index.md"), "utf8")).toContain(
      "decisions/DDR-001-bold-cards.md",
    );
  });

  it("numbers the DDR from the ids the record declares", async () => {
    // The id comes from the concepts' own `id:` frontmatter, the way
    // `forge ddr apply` allocates it. Numbering used to be read off filenames
    // in a root `decisions/` the record does not use, so it restarted at 001
    // next to whatever DDR-001 the record already held (TASK-418).
    await fs.writeFile(
      path.join(repo, "design/decisions/DDR-007-old.md"),
      "---\ntype: Decision\nid: DDR-007\ntitle: Old\ndate: 2026-01-01\ndecision_status: accepted\n---\n## Decision\n\nOld.\n",
    );
    git("add", "-A");
    git("commit", "-qm", "existing ddr");

    await startExplore({ name: "next", sketch: true, cwd: repo });
    git("add", "-A");
    git("commit", "-qm", "sketch");
    git("checkout", "-q", "main");

    const result = await mergeExplore({ name: "next", cwd: repo });
    expect(result.ddrPath).toContain("DDR-008-next.md");
  });

  it("creates a draft DDR for a normal branch and carries comparison synthesis into it", async () => {
    await startExplore({ name: "plain", cwd: repo });
    await fs.writeFile(path.join(repo, "idea.txt"), "x\n");
    git("add", "-A");
    git("commit", "-qm", "work");
    git("checkout", "-q", "main");
    const result = await mergeExplore({
      name: "plain",
      cwd: repo,
      synthesis: {
        rationale: "The compact navigation makes the primary action clearer.",
        observations: [
          { branch: "explore/plain", note: "Best information density." },
          { branch: "explore/roomy", note: "More breathing room, but slower to scan." },
        ],
      },
    });
    expect(result.ddrPath).toBe(path.join(repo, "design/decisions/DDR-001-plain.md"));
    const ddr = await fs.readFile(result.ddrPath!, "utf8");
    expect(ddr).toContain("## Comparison synthesis");
    expect(ddr).toContain("The compact navigation makes the primary action clearer.");
    expect(ddr).toContain("#### explore/roomy");
    expect(ddr).not.toContain("## Sketch brief");

    git("add", "-A");
    git("commit", "-qm", "accept ddr");

    await startExplore({ name: "skipped", sketch: true, cwd: repo });
    git("add", "-A");
    git("commit", "-qm", "sketch");
    git("checkout", "-q", "main");
    expect((await mergeExplore({ name: "skipped", ddr: false, cwd: repo })).ddrPath).toBeNull();
  });

  it("requires main and a clean tree, and a real branch", async () => {
    await expect(mergeExplore({ name: "ghost", cwd: repo })).rejects.toThrow(/no branch/);

    await startExplore({ name: "wip", cwd: repo });
    await expect(mergeExplore({ name: "wip", cwd: repo })).rejects.toThrow(/you are on/);

    git("checkout", "-q", "main");
    await fs.writeFile(path.join(repo, "dirty.txt"), "x\n");
    await expect(mergeExplore({ name: "wip", cwd: repo })).rejects.toThrow(/not clean/);
  });

  it("does not import a SKETCH.md already on main from a prior promotion", async () => {
    // Promote a sketch exploration: its SKETCH.md becomes a DDR and lingers on main.
    await startExplore({ name: "first", sketch: true, cwd: repo });
    git("add", "-A");
    git("commit", "-qm", "sketch");
    git("checkout", "-q", "main");
    const first = await mergeExplore({ name: "first", cwd: repo });
    expect(first.ddrPath).toContain("DDR-001-first.md");
    // the sketch is still on main (history), a DDR is committed alongside
    git("add", "-A");
    git("commit", "-qm", "accept ddr-001");

    // A second, non-sketch exploration is promoted. It gets its own DDR, but
    // the lingering SKETCH.md must not be imported as its source material.
    await startExplore({ name: "second", cwd: repo });
    await fs.writeFile(path.join(repo, "idea.txt"), "x\n");
    git("add", "-A");
    git("commit", "-qm", "work");
    git("checkout", "-q", "main");
    const second = await mergeExplore({ name: "second", cwd: repo });
    expect(second.ddrPath).toContain("DDR-002-second.md");
    const ddr = await fs.readFile(second.ddrPath!, "utf8");
    expect(ddr).not.toContain("## Sketch brief");
  });
});
