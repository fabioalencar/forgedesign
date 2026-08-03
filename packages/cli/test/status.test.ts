import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initProject } from "../src/commands/init.js";
import { collectStatus, formatStatus } from "../src/commands/status.js";
import { registerProject } from "../src/registry.js";

let sandbox: string;
let previousForgeHome: string | undefined;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-status-"));
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

const SAMPLE_TODO = `# demo backlog

## Backlog

- [ ] T-001 First task
- [ ] T-002 Second task
  notes: something
- [x] T-003 Already done but still listed here

## In progress

- [ ] T-004 Underway

## Done

- [x] T-005 Shipped

## Inbox — alpha

- [ ] T-006 Stakeholder comment
`;

const SAMPLE_LEDGER = `---
type: Task Ledger
title: Todos
---
## Todo

- [ ] TASK-001 First task
- [ ] TASK-002 Second task
  notes: something
- [x] TASK-003 Already done but still listed here

## Doing

- [ ] TASK-004 Underway

## Done

- [x] TASK-005 Shipped

## Deferred
`;

describe("collectStatus", () => {
  it("reports branch, open todos by section, and freeze state for a registered project", async () => {
    const root = path.join(sandbox, "demo");
    await initProject(root);
    await fs.writeFile(path.join(root, "design/todos.md"), SAMPLE_LEDGER, "utf8");

    const [status] = await collectStatus();
    expect(status).toBeDefined();
    expect(status?.exists).toBe(true);
    expect(status?.branch).toBeTruthy();
    expect(status?.todoCounts).toEqual([
      { section: "Todo", open: 2 },
      { section: "Doing", open: 1 },
      { section: "Done", open: 0 },
      { section: "Deferred", open: 0 },
    ]);
    expect(status?.lastFreeze).toBeNull();
    expect(status?.unfetchedComments).toEqual({ kind: "not-configured" });
  });

  it("reports no counts for a repo that never migrated (DDR-095)", async () => {
    // A leftover todo/todo.md is not a ledger this build reads, so there are no
    // counts to report — the old numbers described a record no command here
    // will write to.
    const root = path.join(sandbox, "legacy");
    await fs.mkdir(path.join(root, "todo"), { recursive: true });
    await fs.writeFile(path.join(root, "todo/todo.md"), SAMPLE_TODO, "utf8");
    await registerProject({ name: "legacy", path: root });

    const status = (await collectStatus()).find((s) => s.name === "legacy");

    expect(status?.todoCounts).toBeNull();
  });

  it("reads the last entry of freezes.json when present", async () => {
    const root = path.join(sandbox, "demo");
    await initProject(root);
    await fs.mkdir(path.join(root, "todo"), { recursive: true });
    await fs.writeFile(
      path.join(root, "freezes.json"),
      JSON.stringify([
        { tag: "alpha", date: "2026-06-01" },
        { tag: "beta", date: "2026-07-01" },
      ]),
      "utf8",
    );

    const [status] = await collectStatus();
    expect(status?.lastFreeze).toEqual({ tag: "beta", date: "2026-07-01" });
  });

  it("flags registered projects whose directory is gone", async () => {
    const root = path.join(sandbox, "demo");
    await initProject(root);
    await fs.mkdir(path.join(root, "todo"), { recursive: true });
    await fs.rm(root, { recursive: true, force: true });

    const [status] = await collectStatus();
    expect(status?.exists).toBe(false);
    expect(formatStatus([status!])).toContain("missing on disk");
  });

  it("formats an empty registry with a pointer to forge init", async () => {
    expect(formatStatus(await collectStatus())).toContain("No projects registered");
  });
});
