import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeBundleIndex } from "../src/bundle-index.js";
import { runDoctor } from "../src/doctor.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "forge-doctor-v02-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

/** A minimal v0.2 bundle that doctor reports clean. */
async function seedBundle(): Promise<void> {
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
  await write(
    "design/questions/QUESTION-001.md",
    "---\ntype: Question\nid: QUESTION-001\ntitle: Is it used?\nquestion_status: open\n---\n",
  );
}

const rules = (findings: Array<{ rule: string }>): string[] => findings.map((f) => f.rule);

describe("runDoctor on a v0.2 record", () => {
  it("dispatches on formatVersion and reports a conformant bundle clean", async () => {
    await seedBundle();
    const result = await runDoctor(root);
    expect(result.findings).toEqual([]);
    expect(result.exitCode).toBe(0);
  });

  it("fails loudly when forge.json says 0.2 but no bundle exists", async () => {
    await write("forge.json", JSON.stringify({ formatVersion: "0.2" }));
    const result = await runDoctor(root);
    expect(result.exitCode).toBe(2);
    expect(rules(result.findings)).toEqual(["unparseable"]);
  });

  it("reports OKF rule 1: a concept with no parseable frontmatter", async () => {
    await seedBundle();
    await write("design/glossary/path.md", "just prose, no frontmatter\n");
    await write("design/glossary/step.md", "---\ntype: Term\n\tbad: yaml\n---\n");

    const result = await runDoctor(root);

    expect(rules(result.findings).filter((r) => r === "okf-frontmatter")).toHaveLength(2);
  });

  it("reports OKF rule 2: frontmatter without a type", async () => {
    await seedBundle();
    await write("design/glossary/path.md", "---\ntitle: Path\n---\n");
    expect(rules(await runDoctor(root).then((r) => r.findings))).toContain("okf-type");
  });

  it("reports OKF rule 3: frontmatter in reserved files", async () => {
    await seedBundle();
    await write("design/log.md", "---\ntype: Term\n---\n# Log\n");
    await write("design/questions/index.md", '---\nokf_version: "0.2"\n---\n# Questions\n');

    const findings = (await runDoctor(root)).findings;

    // A nested index may not carry frontmatter at all; only the bundle root's may.
    expect(findings.filter((f) => f.rule === "okf-reserved")).toHaveLength(2);
  });

  it("rejects extra keys in the bundle-root index", async () => {
    await seedBundle();
    await write("design/index.md", '---\nokf_version: "0.2"\ntype: Brief\n---\n# The record\n');
    const findings = (await runDoctor(root)).findings;
    expect(findings.find((f) => f.rule === "okf-reserved")?.message).toMatch(
      /only carry okf_version/,
    );
  });

  it("holds ids to their filenames and to uniqueness", async () => {
    await seedBundle();
    await write(
      "design/questions/QUESTION-002.md",
      "---\ntype: Question\nid: QUESTION-001\nquestion_status: open\n---\n",
    );
    const findings = (await runDoctor(root)).findings;
    expect(rules(findings)).toContain("id-shape");
    expect(rules(findings)).toContain("duplicate-id");
  });

  it("reports a concept filed under the wrong type directory", async () => {
    await seedBundle();
    await write(
      "design/stories/QUESTION-003.md",
      "---\ntype: Question\nid: QUESTION-003\nquestion_status: open\n---\n",
    );
    expect(rules((await runDoctor(root)).findings)).toContain("misplaced-concept");
  });

  it("reports an unresolved id reference", async () => {
    await seedBundle();
    await write("design/brief.md", "---\ntype: Brief\n---\nBlocked on TASK-404.\n");
    const findings = (await runDoctor(root)).findings;
    expect(findings.find((f) => f.rule === "unresolved-ref")?.message).toContain("TASK-404");
  });

  it("resolves ids declared inside the task ledger", async () => {
    await seedBundle();
    await write("design/brief.md", "---\ntype: Brief\n---\nTracked as TASK-001.\n");
    expect(rules((await runDoctor(root)).findings)).not.toContain("unresolved-ref");
  });

  it("validates task statuses inside the ledger body", async () => {
    await seedBundle();
    await write(
      "design/todos.md",
      "---\ntype: Task Ledger\n---\n## Todo\n- [ ] TASK-001 Do it\n  status: wandering\n",
    );
    const findings = (await runDoctor(root)).findings;
    expect(findings.find((f) => f.rule === "invalid-enum")?.message).toContain("wandering");
  });

  it("enforces the feedback disposition rules and source enum", async () => {
    await seedBundle();
    await write(
      "design/feedback/FEEDBACK-001.md",
      "---\ntype: Feedback\nid: FEEDBACK-001\nfeedback_status: accepted\nsource: telepathy\n---\n",
    );
    await write(
      "design/feedback/FEEDBACK-002.md",
      "---\ntype: Feedback\nid: FEEDBACK-002\nfeedback_status: declined\nresolution: TASK-001\n---\n",
    );

    const messages = (await runDoctor(root)).findings.map((f) => f.message);

    expect(messages.some((m) => m.includes('invalid feedback source "telepathy"'))).toBe(true);
    expect(messages.some((m) => m.includes("accepted feedback must link a TASK"))).toBe(true);
    expect(messages.some((m) => m.includes("declined feedback must link a DDR"))).toBe(true);
  });

  it("accepts a feedback whose disposition links the right kind of id", async () => {
    await seedBundle();
    await write(
      "design/feedback/FEEDBACK-001.md",
      "---\ntype: Feedback\nid: FEEDBACK-001\nfeedback_status: accepted\nsource: review\nresolution: TASK-001\n---\n",
    );
    expect((await runDoctor(root)).findings).toEqual([]);
  });

  it("reports a generated file naming an unknown generator", async () => {
    await seedBundle();
    await write(
      "design/feature-log.md",
      "---\ntype: Feature Log\ngenerated: { by: some-other-tool }\n---\n- Shipped.\n",
    );
    const findings = (await runDoctor(root)).findings;
    expect(findings.find((f) => f.rule === "derived-marker")?.message).toMatch(/unknown generator/);
  });

  it("accepts a generated file from a generator it knows", async () => {
    await seedBundle();
    await write(
      "design/feature-log.md",
      "---\ntype: Feature Log\ngenerated: { by: forge-cli/0.2.0 }\n---\n- Shipped.\n",
    );
    expect((await runDoctor(root)).findings).toEqual([]);
  });

  it("flags a root file that differs from a spec file only by case", async () => {
    await seedBundle();
    // The real shape of this: a record authored where `Brief.md` is the only
    // brief on disk. Writing both names is impossible here — on a
    // case-insensitive filesystem they are one path, which is the whole
    // problem the rule exists for.
    await fs.rm(path.join(root, "design", "brief.md"));
    await write("design/Brief.md", "---\ntype: Brief\n---\n");

    const findings = (await runDoctor(root)).findings;

    expect(findings.find((f) => f.rule === "case-collision")?.message).toMatch(
      /differs from the record file brief\.md only by case/,
    );
  });

  it("reports a generated index that no longer matches the bundle", async () => {
    await seedBundle();
    await write(
      "design/index.md",
      '---\nokf_version: "0.2"\n---\n<!-- generated by forge index · do not edit -->\n\n# The record\n',
    );

    const findings = (await runDoctor(root)).findings;

    expect(findings.find((f) => f.rule === "stale-index")?.message).toMatch(/run `forge index`/);
  });

  it("leaves a hand-written index alone — it never claimed to be generated", async () => {
    await seedBundle();
    await write("design/index.md", '---\nokf_version: "0.2"\n---\n# My own index\n');
    expect(rules((await runDoctor(root)).findings)).not.toContain("stale-index");
  });

  it("accepts an index regenerated from the bundle", async () => {
    await seedBundle();
    await writeBundleIndex(root);
    expect((await runDoctor(root)).findings).toEqual([]);
  });

  it("does not run any rule against a v0.1 record — it says to upgrade (DDR-095)", async () => {
    await write("forge.json", JSON.stringify({ formatVersion: "0.1" }));
    await write("Brief.md", "# Brief\n");
    await write("Todos.md", "# Todos\n\n## Todo\n- [ ] TASK-001 Do it\n  status: nonsense\n");

    const findings = (await runDoctor(root)).findings;

    expect(rules(findings)).toEqual(["format-version"]);
    expect(findings[0]?.message).toContain("forge upgrade --to 0.2");
  });
});

describe("rule 12: an amendment is recorded on both decisions (DDR-090)", () => {
  const decision = (id: string, front = "") =>
    `---\ntype: Decision\nid: ${id}\ntitle: "A decision"\ndate: 2026-08-03\ndecision_status: accepted\n${front}---\n## Decision\nSomething.\n`;

  it("is clean when both halves are written", async () => {
    await seedBundle();
    await write(
      "design/decisions/DDR-001-first.md",
      decision("DDR-001", "amended_by: [DDR-002]\n"),
    );
    await write("design/decisions/DDR-002-second.md", decision("DDR-002", "amends: [DDR-001]\n"));
    await writeBundleIndex(root);

    const result = await runDoctor(root);
    expect(rules(result.findings)).not.toContain("amendment-unrecorded");
  });

  it("reports the decision that was amended without being told", async () => {
    // The finding lands on the *older* file, because that is the one a reader
    // opens and finds nothing wrong with.
    await seedBundle();
    await write("design/decisions/DDR-001-first.md", decision("DDR-001"));
    await write("design/decisions/DDR-002-second.md", decision("DDR-002", "amends: [DDR-001]\n"));
    await writeBundleIndex(root);

    const result = await runDoctor(root);
    const found = result.findings.find((f) => f.rule === "amendment-unrecorded");
    expect(found?.file).toBe("design/decisions/DDR-001-first.md");
    expect(found?.message).toContain("amended_by: [DDR-002]");
  });

  it("takes a single id as well as a list", async () => {
    await seedBundle();
    await write("design/decisions/DDR-001-first.md", decision("DDR-001", "amended_by: DDR-002\n"));
    await write("design/decisions/DDR-002-second.md", decision("DDR-002", "amends: DDR-001\n"));
    await writeBundleIndex(root);

    expect(rules((await runDoctor(root)).findings)).not.toContain("amendment-unrecorded");
  });

  it("does not read prose, which is why it reads a key at all", async () => {
    // A decision that *describes* other decisions' amendments — DDR-087 is
    // exactly this — must not be credited with making them. A text scan for
    // "amends DDR-###" would report four findings here.
    await seedBundle();
    await write("design/decisions/DDR-001-first.md", decision("DDR-001"));
    await write(
      "design/decisions/DDR-002-second.md",
      decision("DDR-002") + "\nDDR-003 amends DDR-001, and DDR-004 amends DDR-001 too.\n",
    );
    await write("design/decisions/DDR-003-third.md", decision("DDR-003"));
    await write("design/decisions/DDR-004-fourth.md", decision("DDR-004"));
    await writeBundleIndex(root);

    expect(rules((await runDoctor(root)).findings)).not.toContain("amendment-unrecorded");
  });

  it("reports an `amends` that names something that is not a decision here", async () => {
    await seedBundle();
    await write("design/decisions/DDR-002-second.md", decision("DDR-002", "amends: [DDR-404]\n"));
    await writeBundleIndex(root);

    expect(rules((await runDoctor(root)).findings)).toContain("amendment-shape");
  });

  it("reports a decision that claims to amend itself", async () => {
    await seedBundle();
    await write("design/decisions/DDR-002-second.md", decision("DDR-002", "amends: [DDR-002]\n"));
    await writeBundleIndex(root);

    expect(rules((await runDoctor(root)).findings)).toContain("amendment-shape");
  });

  it("does not oblige a target until the amendment is accepted", async () => {
    // A draft is a proposal. Demanding the back-reference now would write into
    // an immutable file on the strength of something that may never be agreed,
    // and the exemption permits adding `amended_by`, not removing it — so a
    // rejected draft would leave a claim nobody could retract.
    await seedBundle();
    await write("design/decisions/DDR-001-first.md", decision("DDR-001"));
    await write(
      "design/decisions/DDR-002-second.md",
      decision("DDR-002", "amends: [DDR-001]\n").replace(
        "decision_status: accepted",
        "decision_status: draft",
      ),
    );
    await writeBundleIndex(root);

    expect(rules((await runDoctor(root)).findings)).not.toContain("amendment-unrecorded");
  });

  it("reports an `amends` that is not an id at all", async () => {
    await seedBundle();
    await write("design/decisions/DDR-002-second.md", decision("DDR-002", "amends: 7\n"));
    await writeBundleIndex(root);

    expect(rules((await runDoctor(root)).findings)).toContain("amendment-shape");
  });
});
