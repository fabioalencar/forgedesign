import { describe, expect, it } from "vitest";

// DDR-087's exemption: adding `amended_by` to an accepted decision is permitted,
// and nothing else is. The narrowness is the point — this rule is most of what
// makes "accepted decisions are immutable" true rather than aspirational.

import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { makeDesignRepo } from "./helpers.js";

let sandbox: string;
beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-amended-"));
});
afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

const DDR = `---
type: Decision
id: DDR-901
title: A decision
date: 2026-08-02
decision_status: accepted
---
## Decision
A thing was decided.
`;

async function repoWithAcceptedDecision() {
  const root = await makeDesignRepo(sandbox);
  const file = path.join(root, "design/decisions/DDR-901-a-decision.md");
  await fs.writeFile(file, DDR);
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-m", "add DDR-901"], { cwd: root });
  return { root, file };
}

describe("accepted-decision immutability with DDR-087's exemption", () => {
  it("permits adding amended_by and nothing else", async () => {
    const { root, file } = await repoWithAcceptedDecision();
    await fs.writeFile(
      file,
      DDR.replace("decision_status: accepted", "decision_status: accepted\namended_by: [DDR-902]"),
    );
    const result = await runDoctor(root, { base: "HEAD" });
    expect(result.findings.filter((f) => f.rule === "ddr-immutable")).toHaveLength(0);
  });

  it("still catches a body edit made alongside adding amended_by", async () => {
    // The exemption must not become a way to smuggle an edit past the rule.
    const { root, file } = await repoWithAcceptedDecision();
    await fs.writeFile(
      file,
      DDR.replace(
        "decision_status: accepted",
        "decision_status: accepted\namended_by: [DDR-902]",
      ).replace("A thing was decided.", "Actually something else was decided."),
    );
    const result = await runDoctor(root, { base: "HEAD" });
    expect(result.findings.filter((f) => f.rule === "ddr-immutable")).toHaveLength(1);
  });

  it("still catches a plain body edit", async () => {
    const { root, file } = await repoWithAcceptedDecision();
    await fs.writeFile(file, DDR.replace("A thing was decided.", "Something else."));
    const result = await runDoctor(root, { base: "HEAD" });
    expect(result.findings.filter((f) => f.rule === "ddr-immutable")).toHaveLength(1);
  });
});
