import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeBundleIndex } from "../src/bundle-index.js";
import { readRecordVersion, versionRefusal } from "../src/record-version.js";

// The `index` command is a thin wrapper: it routes non-current records through
// `versionRefusal` so its "nothing to index" message matches what doctor and
// freeze say, rather than telling a directory that is not a record that it is a
// record without a bundle (TASK-410, DDR-095's sharp edge). These assert the
// message the command prints for each first-touch state, at the seam it uses.

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "forge-index-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("index on a record it cannot serve", () => {
  it("tells a directory with no manifest it is not a record, not a bundleless one", async () => {
    const version = await readRecordVersion(root);
    expect(version.kind).toBe("absent");
    if (version.kind === "current") return;
    expect(versionRefusal(version)).toBe(
      "forge.json not found — not a Forge record (run `forge init`)",
    );
    // And there is genuinely nothing to index.
    expect((await writeBundleIndex(root)).path).toBeNull();
  });

  it("sends a pre-0.2 record to `forge upgrade`, not to init", async () => {
    await fs.writeFile(path.join(root, "Todos.md"), "## Todo\n- [ ] T-001 x\n", "utf8");
    const version = await readRecordVersion(root);
    expect(version.kind).toBe("migratable");
    if (version.kind === "current") return;
    expect(versionRefusal(version)).toContain("forge upgrade --to 0.2");
  });
});
