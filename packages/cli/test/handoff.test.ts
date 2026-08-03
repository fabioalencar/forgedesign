import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFreeze } from "../src/commands/freeze.js";
import { collectHandoffContent, generateHandoffPack } from "../src/handoff.js";
import { makeDesignRepo } from "./helpers.js";

let sandbox: string;
let previousForgeHome: string | undefined;

const INPUTS = {
  tag: "beta",
  message: "second round",
  date: "2026-07-02",
  previewUrl: "https://demo-preview-abc.vercel.app",
  storybookUrl: "https://demo-storybook-abc.vercel.app",
};

const ACCEPTED_DDR = `# DDR-001 — Use widgets

- **Status**: accepted
- **Date**: 2026-07-01
- **Context source**: test

## Decision

Widgets are the primary unit of composition.

## Why

Because.
`;

const PROPOSED_DDR = ACCEPTED_DDR.replace("accepted", "proposed").replace("DDR-001", "DDR-002");

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-handoff-"));
  previousForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = path.join(sandbox, ".forge");
});

afterEach(async () => {
  if (previousForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = previousForgeHome;
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("collectHandoffContent", () => {
  it("gathers glossary bullets, user stories, and accepted DDRs only", async () => {
    const root = await makeDesignRepo(sandbox);
    // The pack reads the record's own concepts now (T-256), so the fixture
    // seeds those rather than the v1 artifacts/ stubs init no longer writes.
    await fs.mkdir(path.join(root, "design/glossary"), { recursive: true });
    await fs.writeFile(
      path.join(root, "design/glossary/widget.md"),
      "---\ntype: Term\ntitle: Widget\n---\na thing.\n",
    );
    await fs.writeFile(
      path.join(root, "design/glossary/gadget.md"),
      "---\ntype: Term\ntitle: Gadget\n---\nanother thing.\n",
    );
    await fs.mkdir(path.join(root, "design/stories"), { recursive: true });
    await fs.writeFile(
      path.join(root, "design/stories/STORY-001.md"),
      "---\ntype: Story\nid: STORY-001\ntitle: As a PM, I want pins.\n---\n",
    );
    // init scaffolds decisions/ inside the bundle now; the handoff pack still
    // reads the root layout, which is what T-256 ports.
    await fs.mkdir(path.join(root, "decisions"), { recursive: true });
    await fs.writeFile(path.join(root, "decisions/DDR-001-widgets.md"), ACCEPTED_DDR);
    await fs.writeFile(path.join(root, "decisions/DDR-002-proposed.md"), PROPOSED_DDR);

    const content = await collectHandoffContent(root, INPUTS);
    // Alphabetical, because the bundle scan is path-sorted — a better order for
    // a glossary than whatever order the files happened to be written in.
    expect(content.glossary).toEqual(["Gadget — another thing.", "Widget — a thing."]);
    expect(content.userStories).toEqual(["As a PM, I want pins."]);
    expect(content.ddrs.map((d) => d.title)).toEqual(["DDR-001 — Use widgets"]);
    expect(content.ddrs[0]?.decision).toBe("Widgets are the primary unit of composition.");
    expect(content.previousTag).toBeNull();
  });

  it("limits DDRs to those changed since the previous freeze tag", async () => {
    const root = await makeDesignRepo(sandbox);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    // init scaffolds decisions/ inside the bundle now; the handoff pack still
    // reads the root layout, which is what T-256 ports.
    await fs.mkdir(path.join(root, "decisions"), { recursive: true });
    await fs.writeFile(path.join(root, "decisions/DDR-001-widgets.md"), ACCEPTED_DDR);
    git("add", "-A");
    git("commit", "-m", "ddr-1");
    await runFreeze({ tag: "alpha", message: "first", cwd: root });

    // a DDR accepted after the alpha freeze
    await fs.writeFile(
      path.join(root, "decisions/DDR-003-post-alpha.md"),
      ACCEPTED_DDR.replace("DDR-001 — Use widgets", "DDR-003 — Post alpha"),
    );
    git("add", "-A");
    git("commit", "-m", "ddr-3");

    const content = await collectHandoffContent(root, INPUTS);
    expect(content.previousTag).toBe("alpha");
    expect(content.ddrs.map((d) => d.title)).toEqual(["DDR-003 — Post alpha"]);
  });
});

describe("generateHandoffPack", () => {
  it("writes a real PDF and a real docx into handoff/<tag>/", async () => {
    const root = await makeDesignRepo(sandbox);
    const { files } = await generateHandoffPack(root, INPUTS);

    const pdf = await fs.readFile(path.join(root, "handoff/beta/handoff-beta.pdf"));
    const docx = await fs.readFile(path.join(root, "handoff/beta/handoff-beta.docx"));
    expect(files).toHaveLength(2);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(docx.subarray(0, 2).toString()).toBe("PK"); // zip container
    expect(pdf.length).toBeGreaterThan(1000);
    expect(docx.length).toBeGreaterThan(1000);
  });
});

describe("freeze handoff step", () => {
  it("generates and commits the handoff pack as part of the ceremony", async () => {
    const root = await makeDesignRepo(sandbox);
    await runFreeze({ tag: "alpha", message: "first", cwd: root });

    const git = (...args: string[]) => execFileSync("git", args, { cwd: root }).toString().trim();
    expect(git("status", "--porcelain")).toBe("");
    expect(git("ls-files", "handoff/alpha")).toContain("handoff/alpha/handoff-alpha.pdf");
    expect(git("ls-files", "handoff/alpha")).toContain("handoff/alpha/handoff-alpha.docx");
  });
});
