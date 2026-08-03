import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createDataset,
  type DatasetEntitySpec,
  generateDatasetId,
  generateDatasetRecords,
  getDataset,
  importDataset,
  listDatasets,
  parseDatasetReference,
  resolveDatasetReference,
  updateDataset,
  validateDatasetRelationships,
} from "../src/datasets.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-datasets-"));
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const root = path.join(sandbox, "repo");
  await fs.mkdir(root, { recursive: true });
  return root;
}

const usersEntity: DatasetEntitySpec = {
  name: "users",
  count: 3,
  fields: {
    id: { type: "id", prefix: "usr-" },
    name: { type: "name" },
    email: { type: "email" },
  },
};

const proposalsEntity: DatasetEntitySpec = {
  name: "proposals",
  count: 5,
  fields: {
    id: { type: "id", prefix: "prp-" },
    authorId: { type: "ref", entity: "users", field: "id" },
    status: { type: "enum", values: ["draft", "complete", "overdue"] },
    summary: { type: "sentence", words: 6 },
    amount: { type: "number", min: 1000, max: 50_000 },
    signedOff: { type: "boolean" },
    dueDate: { type: "date", startDaysAgo: 30, endDaysAgo: 0 },
  },
};

describe("generateDatasetId", () => {
  it("produces distinct ds-<8 lowercase base32 chars> ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateDatasetId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^ds-[0-9a-hjkmnp-tv-z]{8}$/);
  });
});

describe("generateDatasetRecords", () => {
  it("is deterministic for a given seed and varies across seeds", () => {
    const first = generateDatasetRecords([usersEntity, proposalsEntity], 42);
    const second = generateDatasetRecords([usersEntity, proposalsEntity], 42);
    const third = generateDatasetRecords([usersEntity, proposalsEntity], 43);
    expect(first).toEqual(second);
    expect(first).not.toEqual(third);
  });

  it("gives every proposal a real, resolvable author id", () => {
    const records = generateDatasetRecords([usersEntity, proposalsEntity], 7);
    const userIds = new Set(records.users!.map((u) => (u as { id: string }).id));
    for (const proposal of records.proposals as { authorId: string }[]) {
      expect(userIds.has(proposal.authorId)).toBe(true);
    }
  });

  it("throws when a ref points to an entity that has not been generated yet", () => {
    expect(() => generateDatasetRecords([proposalsEntity, usersEntity], 1)).toThrow(
      /not generated yet/,
    );
  });

  it("produces sequential ids independent of seed", () => {
    const records = generateDatasetRecords([usersEntity], 999);
    expect(records.users!.map((u) => (u as { id: string }).id)).toEqual([
      "usr-0001",
      "usr-0002",
      "usr-0003",
    ]);
  });
});

describe("validateDatasetRelationships", () => {
  it("passes for referentially consistent records", () => {
    const records = generateDatasetRecords([usersEntity, proposalsEntity], 5);
    const violations = validateDatasetRelationships(records, [
      { from: "proposals.authorId", to: "users.id" },
    ]);
    expect(violations).toEqual([]);
  });

  it("catches a dangling reference", () => {
    const records = {
      users: [{ id: "usr-0001" }],
      proposals: [{ id: "prp-0001", authorId: "usr-9999" }],
    };
    const violations = validateDatasetRelationships(records, [
      { from: "proposals.authorId", to: "users.id" },
    ]);
    expect(violations).toEqual([
      {
        relationship: { from: "proposals.authorId", to: "users.id" },
        recordIndex: 0,
        value: "usr-9999",
      },
    ]);
  });
});

describe("createDataset", () => {
  it("writes a manifest and one records file per entity, all reparseable", async () => {
    const root = await repo();
    const dataset = await createDataset({
      cwd: root,
      title: "Contract proposals",
      entities: [usersEntity, proposalsEntity],
      relationships: [{ from: "proposals.authorId", to: "users.id" }],
      seed: 42,
    });

    expect(dataset.slug).toBe("contract-proposals");
    expect(dataset.manifest.provenance).toBe("synthetic");
    expect(dataset.manifest.generator).toEqual({
      name: "forge-datasets",
      version: "1.0.0",
      seed: 42,
    });

    const manifestFile = await fs.readFile(
      path.join(root, "datasets/contract-proposals/dataset.md"),
      "utf8",
    );
    expect(manifestFile).toContain("type: dataset");
    expect(manifestFile).toContain("entities: [users, proposals]");
    expect(manifestFile).toContain("proposals.authorId: users.id");

    const usersFile = JSON.parse(
      await fs.readFile(path.join(root, "datasets/contract-proposals/records/users.json"), "utf8"),
    );
    expect(usersFile).toHaveLength(3);

    const reread = await getDataset("contract-proposals", root);
    expect(reread?.records.proposals).toHaveLength(5);
    expect(reread?.manifest.relationships).toEqual([
      { from: "proposals.authorId", to: "users.id" },
    ]);
  });

  it("rejects a declared relationship the generated data cannot satisfy", async () => {
    const root = await repo();
    const orphanProposals: DatasetEntitySpec = {
      name: "proposals",
      count: 2,
      // A plain enum, not a "ref" — generation succeeds on its own, but the
      // declared relationship below can never be satisfied by these values.
      fields: {
        id: { type: "id", prefix: "prp-" },
        authorId: { type: "enum", values: ["nobody"] },
      },
    };
    await expect(
      createDataset({
        cwd: root,
        title: "Broken",
        entities: [usersEntity, orphanProposals],
        relationships: [{ from: "proposals.authorId", to: "users.id" }],
        seed: 1,
      }),
    ).rejects.toThrow(/violates 2 declared relationship/);
  });

  it("disambiguates a slug collision between two same-titled datasets", async () => {
    const root = await repo();
    const first = await createDataset({
      cwd: root,
      title: "Users",
      entities: [usersEntity],
      seed: 1,
    });
    const second = await createDataset({
      cwd: root,
      title: "Users",
      entities: [usersEntity],
      seed: 2,
    });
    expect(first.slug).toBe("users");
    expect(second.slug).toBe("users-2");
  });
});

describe("importDataset", () => {
  it("requires a non-trivial written acknowledgment", async () => {
    const root = await repo();
    await expect(
      importDataset({
        cwd: root,
        title: "Legacy export",
        records: { users: [{ id: "usr-1" }] },
        acknowledgment: "ok",
      }),
    ).rejects.toThrow(/written acknowledgment/);
  });

  it("records provenance and the acknowledgment verbatim", async () => {
    const root = await repo();
    const acknowledgment =
      "Anonymized export from the legacy CRM sandbox, reviewed by design lead before import.";
    const dataset = await importDataset({
      cwd: root,
      title: "Legacy export",
      records: { users: [{ id: "usr-1", name: "Test User" }] },
      acknowledgment,
    });
    expect(dataset.manifest.provenance).toBe("imported");
    expect(dataset.manifest.importedAcknowledgment).toBe(acknowledgment);
    expect(dataset.manifest.generator).toBeUndefined();

    const reread = await getDataset(dataset.slug, root);
    expect(reread?.manifest.importedAcknowledgment).toBe(acknowledgment);
  });

  it("rejects an imported relationship violation the same way as generation", async () => {
    const root = await repo();
    await expect(
      importDataset({
        cwd: root,
        title: "Broken import",
        records: { users: [{ id: "usr-1" }], proposals: [{ authorId: "usr-missing" }] },
        relationships: [{ from: "proposals.authorId", to: "users.id" }],
        acknowledgment: "A hand-authored fixture with a deliberately broken reference for testing.",
      }),
    ).rejects.toThrow(/violates 1 declared relationship/);
  });
});

describe("listDatasets / getDataset", () => {
  it("lists no datasets when datasets/ does not exist yet", async () => {
    const root = await repo();
    expect(await listDatasets(root)).toEqual([]);
    expect(await getDataset("nothing", root)).toBeNull();
  });

  it("lists created datasets sorted by title", async () => {
    const root = await repo();
    await createDataset({ cwd: root, title: "Zebra", entities: [usersEntity], seed: 1 });
    await createDataset({ cwd: root, title: "Alpha", entities: [usersEntity], seed: 2 });
    expect((await listDatasets(root)).map((d) => d.manifest.title)).toEqual(["Alpha", "Zebra"]);
  });
});

describe("updateDataset (DDR-046 versioning)", () => {
  it("bumps the version and overwrites records in place", async () => {
    const root = await repo();
    const created = await createDataset({
      cwd: root,
      title: "Users",
      entities: [usersEntity],
      seed: 1,
    });
    expect(created.manifest.version).toBe(1);

    const updated = await updateDataset(
      created.slug,
      { records: { users: [{ id: "usr-0001", name: "Replaced User" }] } },
      root,
    );

    expect(updated.manifest.version).toBe(2);
    expect(updated.records.users).toEqual([{ id: "usr-0001", name: "Replaced User" }]);

    const reread = await getDataset(created.slug, root);
    expect(reread?.manifest.version).toBe(2);
    expect(reread?.records.users).toEqual([{ id: "usr-0001", name: "Replaced User" }]);
  });

  it("rejects an update that breaks a declared relationship", async () => {
    const root = await repo();
    const created = await createDataset({
      cwd: root,
      title: "Contract proposals",
      entities: [usersEntity, proposalsEntity],
      relationships: [{ from: "proposals.authorId", to: "users.id" }],
      seed: 3,
    });
    await expect(
      updateDataset(created.slug, { records: { ...created.records, users: [] } }, root),
    ).rejects.toThrow(/violates \d+ declared relationship/);
  });
});

describe("dataset reference resolution (reuse across scenarios)", () => {
  it("parses a scn-style ds-<id>@<version> reference", () => {
    expect(parseDatasetReference("ds-4qn8w2vt@2")).toEqual({ id: "ds-4qn8w2vt", version: 2 });
    expect(parseDatasetReference("not-a-reference")).toBeNull();
  });

  it("resolves a reference against the current working tree", async () => {
    const root = await repo();
    const created = await createDataset({
      cwd: root,
      title: "Users",
      entities: [usersEntity],
      seed: 1,
    });
    const resolved = await resolveDatasetReference(`${created.manifest.id}@1`, root);
    expect(resolved?.slug).toBe(created.slug);
    expect(await resolveDatasetReference(`${created.manifest.id}@2`, root)).toBeNull();
    expect(await resolveDatasetReference("ds-00000000@1", root)).toBeNull();
  });
});
