import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConcept, readChange } from "@forgedesign/format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyChangelog, type ChangelogBatch, draftChangelog } from "../src/changelog.js";
import { runDoctor } from "../src/doctor.js";
import { initProject } from "../src/init.js";
import { CHANGELOG_FILE, collectRecord } from "../src/publish.js";

let sandbox: string;
let root: string;
let previousForgeHome: string | undefined;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-changelog-"));
  previousForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = path.join(sandbox, ".forge");
  root = path.join(sandbox, "demo");
  await initProject(root);
  git("add", "-A");
  git("commit", "-qm", "init");
});

afterEach(async () => {
  if (previousForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = previousForgeHome;
  await fs.rm(sandbox, { recursive: true, force: true });
});

function git(...args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

const row = (id: string, title: string, status: string, extra: string[] = []) =>
  [
    `- [${status === "done" ? "x" : " "}] ${id} ${title}`,
    `  status: ${status} · opened: 2026-07-01`,
    ...extra.map((line) => `  ${line}`),
  ].join("\n");

/** Replace the ledger's sections with these rows. */
async function writeLedger(rows: { doing?: string[]; done?: string[] }): Promise<void> {
  const ledgerPath = path.join(root, "design", "todos.md");
  const current = await fs.readFile(ledgerPath, "utf8");
  const concept = parseConcept("todos.md", current);
  const body = [
    "## Todo",
    "",
    "## Doing",
    ...(rows.doing ?? []),
    "",
    "## Done",
    ...(rows.done ?? []),
    "",
    "## Deferred",
    "",
  ].join("\n");
  await fs.writeFile(
    ledgerPath,
    `${current.slice(0, current.length - concept.body.length)}${body}`,
    "utf8",
  );
}

async function write(relPath: string, text: string): Promise<void> {
  const file = path.join(root, "design", relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}

async function writeFreezes(tags: Array<[string, string]>): Promise<void> {
  const records = tags.map(([tag, date]) => ({
    tag,
    date,
    commit: "x",
    previewUrl: null,
    storybookUrl: null,
    snapshotId: null,
  }));
  await fs.writeFile(path.join(root, "freezes.json"), `${JSON.stringify(records, null, 2)}\n`);
}

function commitAndTag(tag: string): void {
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", tag);
  git("tag", "-a", tag, "-m", tag);
}

const change = (id: string, fields: string, body = "What a reader will notice.\n") =>
  `---\ntype: Change\nid: ${id}\ntitle: ${id} title\ndate: 2026-11-01\n${fields}---\n${body}`;

async function readBatch(batch: string): Promise<ChangelogBatch> {
  return JSON.parse(
    await fs.readFile(path.join(root, ".forge", "changelog", `${batch}.json`), "utf8"),
  ) as ChangelogBatch;
}

async function saveBatch(batch: string, staged: ChangelogBatch): Promise<void> {
  await fs.writeFile(
    path.join(root, ".forge", "changelog", `${batch}.json`),
    `${JSON.stringify(staged, null, 2)}\n`,
  );
}

/** A record where TASK-002 closed since v1 because Julia asked, and TASK-003 is in Doing. */
async function seedSinceV1(): Promise<void> {
  await writeLedger({ done: [row("TASK-001", "Old work", "done")] });
  await writeFreezes([["v1", "2026-10-01"]]);
  commitAndTag("v1");

  await writeLedger({
    doing: [row("TASK-003", "Explore a passkey sign-in", "doing")],
    done: [
      row("TASK-001", "Old work", "done"),
      row("TASK-002", "Fix the sign-in error copy", "done", ["genesis: FEEDBACK-001"]),
    ],
  });
  await write(
    "stakeholders/STAKEHOLDER-001.md",
    "---\ntype: Stakeholder\nid: STAKEHOLDER-001\ntitle: Julia — invited reviewer\ndate: 2026-08-03\n---\n",
  );
  await write(
    "feedback/FEEDBACK-001.md",
    [
      "---",
      "type: Feedback",
      "id: FEEDBACK-001",
      "title: The error does not say what is wrong",
      "date: 2026-10-05",
      "feedback_status: accepted",
      "source: issue",
      "url: https://github.com/acme/app/issues/7",
      "from: STAKEHOLDER-001",
      "route: /sign-in/",
      "resolution: TASK-002",
      "---",
      "",
      "> The error does not say what is wrong.",
      "",
    ].join("\n"),
  );
  await write(
    "pages.md",
    "---\ntype: Page Manifest\ntitle: Pages\n---\n- /sign-in · Sign in — TASK-002\n",
  );
}

describe("forge changelog draft (DDR-176)", () => {
  it("stages a done candidate per task closed since the last freeze, and an exploring one per task in Doing, none kept", async () => {
    await seedSinceV1();

    const result = await draftChangelog(root);

    expect(result.since).toBe("v1");
    expect(result.entries).toEqual([
      {
        keep: false,
        action: "new",
        title: "Fix the sign-in error copy",
        body: "",
        change_status: "done",
        routes: ["/sign-in"],
        requested_by: "Julia",
        links: ["https://github.com/acme/app/issues/7"],
        refs: ["TASK-002", "FEEDBACK-001"],
        reason: "TASK-002 reached Done since v1",
      },
      {
        keep: false,
        action: "new",
        title: "Explore a passkey sign-in",
        body: "",
        change_status: "exploring",
        routes: [],
        requested_by: null,
        links: [],
        refs: ["TASK-003"],
        reason: "TASK-003 is in Doing",
      },
    ]);
    const staged = await readBatch(result.batch);
    expect(staged.notice).toContain("everyone holding the review PIN");
    expect(staged.entries).toEqual(result.entries);
  });

  it("names the reviewer a review-sourced feedback carries, which is a typed name rather than a stakeholder id", async () => {
    await writeFreezes([["v1", "2026-10-01"]]);
    commitAndTag("v1");
    await writeLedger({ done: [row("TASK-005", "Accept any email", "done")] });
    await write(
      "feedback/FEEDBACK-002.md",
      [
        "---",
        "type: Feedback",
        "id: FEEDBACK-002",
        "title: dont need to be a work email",
        "date: 2026-08-03",
        "feedback_status: accepted",
        "source: review",
        "from: Marco",
        "resolution: TASK-005",
        "route: /",
        "---",
        "",
        "> dont need to be a work email",
        "",
      ].join("\n"),
    );

    const { entries } = await draftChangelog(root);

    expect(entries[0]).toMatchObject({ requested_by: "Marco", routes: ["/"] });
  });

  it("proposes flipping a coming entry to done once every task behind it is done, and no duplicate for those tasks", async () => {
    await writeLedger({ doing: [row("TASK-004", "Passwordless sign-in", "doing")] });
    await writeFreezes([["v1", "2026-10-01"]]);
    await write(
      "changes/CHANGE-001.md",
      change("CHANGE-001", "change_status: coming\nrequested_by: Ana\nrefs: [TASK-004]\n"),
    );
    commitAndTag("v1");
    await writeLedger({ done: [row("TASK-004", "Passwordless sign-in", "done")] });

    const { entries } = await draftChangelog(root);

    expect(entries).toEqual([
      {
        keep: false,
        action: "update",
        id: "CHANGE-001",
        change_status: "done",
        reason: "every task behind CHANGE-001 is done (TASK-004) — it shipped in this version",
      },
    ]);
  });
});

describe("forge changelog apply (DDR-176)", () => {
  it("writes only what was kept, allocates ids, notes routes pages.md lacks, and refuses a second apply", async () => {
    await seedSinceV1();
    const { batch } = await draftChangelog(root);
    const staged = await readBatch(batch);
    staged.entries[0] = {
      ...staged.entries[0],
      keep: true,
      title: "Sign-in says which field is wrong",
      body: "The error under the email field now names the problem.",
    } as ChangelogBatch["entries"][number];
    staged.entries.push({
      keep: true,
      action: "new",
      title: "Passwordless sign-in",
      change_status: "coming",
      routes: ["/passkeys"],
    });
    await saveBatch(batch, staged);

    const result = await applyChangelog(root, batch);

    expect(result.written.map(({ id, action }) => [id, action])).toEqual([
      ["CHANGE-001", "new"],
      ["CHANGE-002", "new"],
    ]);
    expect(result.skipped).toBe(1);
    expect(result.notes).toEqual([
      "CHANGE-002: `/passkeys` is not in pages.md — add a row if it is a page",
    ]);

    const text = await fs.readFile(path.join(root, "design/changes/CHANGE-001.md"), "utf8");
    const concept = parseConcept("changes/CHANGE-001.md", text);
    expect(concept.problems).toEqual([]);
    expect(readChange(concept).change).toMatchObject({
      title: "Sign-in says which field is wrong",
      status: "done",
      routes: ["/sign-in"],
      requestedBy: "Julia",
      refs: ["TASK-002", "FEEDBACK-001"],
    });
    expect(concept.body.trim()).toBe("The error under the email field now names the problem.");
    expect(await fs.readFile(path.join(root, "design/index.md"), "utf8")).toContain("CHANGE-002");

    const doctor = await runDoctor(root);
    expect(doctor.findings).toEqual([]);

    await expect(applyChangelog(root, batch)).rejects.toThrow(/was applied at/);
  });

  it("writes nothing when one kept entry is malformed", async () => {
    await seedSinceV1();
    const { batch } = await draftChangelog(root);
    const staged = await readBatch(batch);
    staged.entries = staged.entries.map((entry) => ({ ...entry, keep: true }));
    staged.entries[1] = {
      ...staged.entries[1],
      links: ["linear ACM-42"],
    } as ChangelogBatch["entries"][number];
    await saveBatch(batch, staged);

    await expect(applyChangelog(root, batch)).rejects.toThrow(/nothing written/);
    await expect(fs.readdir(path.join(root, "design/changes"))).rejects.toThrow();
  });

  it("an update moves only the fields it names, and a null requester takes the name off", async () => {
    await writeFreezes([["v1", "2026-10-01"]]);
    await write(
      "changes/CHANGE-001.md",
      change("CHANGE-001", "change_status: coming\nrequested_by: Ana\nrefs: [TASK-004]\n"),
    );
    await writeLedger({ done: [row("TASK-004", "Passwordless sign-in", "done")] });
    await fs.mkdir(path.join(root, ".forge", "changelog"), { recursive: true });
    await saveBatch("manual", {
      kind: "forge-changelog-draft",
      createdAt: "2026-11-08T00:00:00.000Z",
      since: "v1",
      notice: "",
      entries: [
        {
          keep: true,
          action: "update",
          id: "CHANGE-001",
          change_status: "done",
          requested_by: null,
        },
      ],
    });

    await applyChangelog(root, "manual");

    const concept = parseConcept(
      "changes/CHANGE-001.md",
      await fs.readFile(path.join(root, "design/changes/CHANGE-001.md"), "utf8"),
    );
    expect(concept.domainStatus?.value).toBe("done");
    expect(concept.frontmatter.requested_by).toBeUndefined();
    expect(concept.title).toBe("CHANGE-001 title");
    expect(concept.frontmatter.refs).toEqual(["TASK-004"]);
    expect(concept.body).toBe("What a reader will notice.\n");
  });
});

describe("doctor rule 14: change entries", () => {
  it("reports a relative route and a link that is not a URL", async () => {
    await write(
      "changes/CHANGE-001.md",
      change("CHANGE-001", "change_status: done\nroutes: [sign-in]\nlinks: [ACM-42]\n"),
    );
    const { findings } = await runDoctor(root);
    const rule14 = findings.filter((finding) => finding.rule === "change-entry");
    expect(rule14.map((finding) => finding.message)).toEqual([
      "CHANGE-001: `sign-in` is not a root-relative route — write it as the build serves it, e.g. `/register`",
      "CHANGE-001: `ACM-42` is not an http(s) URL",
    ]);
  });
});

describe("publish derives the version each done change shipped in (DDR-176)", () => {
  it("names the earliest freeze of the run in which the entry reads done, and sends it as changelog.json", async () => {
    await write("changes/CHANGE-001.md", change("CHANGE-001", "change_status: exploring\n"));
    commitAndTag("v1");
    await write("changes/CHANGE-001.md", change("CHANGE-001", "change_status: done\n"));
    await write("changes/CHANGE-002.md", change("CHANGE-002", "change_status: done\n"));
    await write(
      "changes/CHANGE-009.md",
      change("CHANGE-009", "change_status: done\naudience: owner\n"),
    );
    commitAndTag("v2");
    await write("changes/CHANGE-003.md", change("CHANGE-003", "change_status: done\n"));
    await write("changes/CHANGE-004.md", change("CHANGE-004", "change_status: coming\n"));
    commitAndTag("v3");
    await writeFreezes([
      ["v1", "2026-10-01"],
      ["v2", "2026-10-15"],
      ["v3", "2026-11-01"],
    ]);

    const snapshot = await collectRecord(root, "v3", "design");

    const paths = snapshot.files.map((file) => file.path);
    expect(paths).toContain(CHANGELOG_FILE);
    expect(paths).not.toContain("changes/CHANGE-009.md");
    const file = snapshot.files.find((entry) => entry.path === CHANGELOG_FILE);
    expect(file?.contentType).toBe("application/json");
    const changelog = JSON.parse(Buffer.from(file?.content ?? "", "base64").toString("utf8"));
    expect(changelog.tag).toBe("v3");
    expect(changelog.generated.by).toMatch(/^forge-cli\//);
    const shipped = Object.fromEntries(
      changelog.entries.map((e: { id: string; shippedIn: unknown }) => [e.id, e.shippedIn]),
    );
    expect(shipped).toEqual({
      "CHANGE-001": { tag: "v2", date: "2026-10-15" },
      "CHANGE-002": { tag: "v2", date: "2026-10-15" },
      "CHANGE-003": { tag: "v3", date: "2026-11-01" },
      "CHANGE-004": null,
    });
    expect(changelog.entries[0]).toMatchObject({
      id: "CHANGE-001",
      title: "CHANGE-001 title",
      status: "done",
      body: "What a reader will notice.",
      date: "2026-11-01",
      routes: [],
      requestedBy: null,
      links: [],
    });
  });

  it("carries each entry as the format reads it, and the page titles from pages.md", async () => {
    await write(
      "changes/CHANGE-001.md",
      change(
        "CHANGE-001",
        "change_status: done\nroutes: [/sign-in/]\nrequested_by: Ana Martins\nlinks: [https://linear.app/acme/issue/ACM-112]\n",
        "The error sits under the field.\n",
      ),
    );
    await write(
      "pages.md",
      "---\ntype: Page Manifest\ntitle: Pages\n---\n- /sign-in · Sign in — CHANGE-001\n",
    );
    commitAndTag("v1");
    await writeFreezes([["v1", "2026-10-01"]]);

    const { files } = await collectRecord(root, "v1", "design");
    const file = files.find((entry) => entry.path === CHANGELOG_FILE);
    const changelog = JSON.parse(Buffer.from(file?.content ?? "", "base64").toString("utf8"));

    expect(changelog.pages).toEqual({ "/sign-in": "Sign in" });
    expect(changelog.entries).toEqual([
      {
        id: "CHANGE-001",
        title: "CHANGE-001 title",
        status: "done",
        body: "The error sits under the field.",
        date: "2026-11-01",
        routes: ["/sign-in"],
        requestedBy: "Ana Martins",
        links: ["https://linear.app/acme/issue/ACM-112"],
        shippedIn: { tag: "v1", date: "2026-10-01" },
      },
    ]);
  });

  it("sends no changelog.json when no change entry crosses", async () => {
    commitAndTag("v1");
    await writeFreezes([["v1", "2026-10-01"]]);
    const snapshot = await collectRecord(root, "v1", "design");
    expect(snapshot.files.map((file) => file.path)).not.toContain(CHANGELOG_FILE);
  });
});
