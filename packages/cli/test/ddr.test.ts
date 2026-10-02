import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "../src/commands/init.js";
import { applyDdr } from "../src/ddr.js";
import { runDoctor } from "../src/doctor.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "forge-ddr-"));
  // `ddr apply` writes into the bundle and refuses anything older (DDR-095);
  // these used to run against a bare directory that the deleted v0.1 writer
  // turned into a root-level `decisions/`.
  await initProject(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function stage(slug: string, content: object): Promise<void> {
  const dir = path.join(root, ".forge", "ddr");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${slug}.json`), JSON.stringify(content), "utf8");
}

describe("applyDdr", () => {
  it("throws with a clear error when nothing is staged", async () => {
    await expect(applyDdr(root, "no-such-slug")).rejects.toThrow(/no staged decision/);
  });

  it("rejects a malformed slug before touching anything", async () => {
    await expect(applyDdr(root, "Not_A_Slug")).rejects.toThrow(/lowercase slug/);
  });

  it("rejects a staged decision missing required fields", async () => {
    await stage("half-baked", { title: "Half baked" });
    await expect(applyDdr(root, "half-baked")).rejects.toThrow(/contextSource/);
  });

  it("rejects an invalid status", async () => {
    await stage("bad-status", {
      title: "x",
      contextSource: "x",
      decision: "x",
      why: "x",
      status: "maybe",
    });
    await expect(applyDdr(root, "bad-status")).rejects.toThrow(/status must be one of/);
  });

  it("allocates the next id in a fresh bundle and writes the concept shape", async () => {
    await stage("first-decision", {
      title: "First decision",
      contextSource: "conversation with the creator",
      decision: "We decided X.",
      why: "Because Y.",
    });

    const result = await applyDdr(root, "first-decision");
    expect(result.path).toBe(path.join("design", "decisions", `${result.id}-first-decision.md`));

    const text = await fs.readFile(path.join(root, result.path), "utf8");
    expect(text).toContain(`id: ${result.id}`);
    expect(text).toContain("title: First decision");
    expect(text).toContain("decision_status: draft");
    expect(text).toContain("context_source: conversation with the creator");
    expect(text).toContain("## Decision\n\nWe decided X.");
    expect(text).toContain("## Why\n\nBecause Y.");
    expect(text).not.toContain("## Alternatives rejected");
    expect(text).not.toContain("## Consequences");
    // Absent from the staging means absent from the file — the reader defaults it.
    expect(text).not.toContain("reach:");
  });

  it("writes the staged reach and refuses one outside the enum (TASK-457)", async () => {
    const base = { title: "x", contextSource: "x", decision: "x", why: "x" };
    await stage("house-rule", { ...base, reach: "general", audience: "stakeholders" });
    const result = await applyDdr(root, "house-rule");
    const text = await fs.readFile(path.join(root, result.path), "utf8");
    expect(text).toContain("reach: general");
    // And who may see it (DDR-128), written only when staged — absent is the creator's.
    expect(text).toContain("audience: stakeholders");
    expect((await runDoctor(root)).exitCode).toBe(0);
    await stage("bad-audience", { ...base, audience: "everyone" });
    await expect(applyDdr(root, "bad-audience")).rejects.toThrow(/audience must be one of/);

    await stage("bad-reach", { ...base, reach: "everywhere" });
    await expect(applyDdr(root, "bad-reach")).rejects.toThrow(/reach must be one of/);
  });

  it("allocates the next id after existing decisions, and includes optional sections when provided", async () => {
    const decisions = path.join(root, "design", "decisions");
    await fs.mkdir(decisions, { recursive: true });
    const stub = (id: string, title: string) =>
      `---\ntype: Decision\nid: ${id}\ntitle: ${title}\ndate: 2026-07-01\ndecision_status: accepted\ncontext_source: test\n---\n## Decision\n\nX\n`;
    await fs.writeFile(path.join(decisions, "DDR-001-first.md"), stub("DDR-001", "First"), "utf8");
    await fs.writeFile(path.join(decisions, "DDR-003-third.md"), stub("DDR-003", "Third"), "utf8");

    await stage("fourth-decision", {
      title: "Fourth decision",
      status: "accepted",
      contextSource: "2026-07-24 session",
      decision: "We decided Z.",
      why: "Because W.",
      alternativesRejected: "Considered Q; rejected because R.",
      consequences: "Makes S easier.",
    });

    const result = await applyDdr(root, "fourth-decision");
    expect(result.id).toBe("DDR-004"); // max(1, 3) + 1, not count-based

    const text = await fs.readFile(path.join(root, result.path), "utf8");
    expect(text).toContain("decision_status: accepted");
    expect(text).toContain("## Alternatives rejected\n\nConsidered Q; rejected because R.");
    expect(text).toContain("## Consequences\n\nMakes S easier.");
  });

  it("produces a decision that forge doctor accepts", async () => {
    await stage("clean-decision", {
      title: "Clean decision",
      contextSource: "conversation",
      decision: "X.",
      why: "Y.",
    });
    await applyDdr(root, "clean-decision");

    const result = await runDoctor(root);
    expect(result.exitCode).toBe(0);
  });
});
