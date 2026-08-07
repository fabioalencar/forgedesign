// Refusing to run a binary older than its source (TASK-381).
//
// The behaviour under test is a refusal, so most of these are about when it must
// *not* fire. A guard that cries wolf on an installed package would be worse
// than the silence it replaces: every user who installed from npm has no `src/`
// beside `dist/`, and must never see any of this.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkStaleBuild, OVERRIDE_ENV, staleMessage } from "../src/staleness.js";

let root: string;
let savedOverride: string | undefined;

const binary = () => path.join(root, "dist", "index.js");

/** Writes a file with an explicit mtime, so the test does not race the clock. */
async function write(relPath: string, mtimeMs: number): Promise<string> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, "x", "utf8");
  await fs.utimes(abs, mtimeMs / 1000, mtimeMs / 1000);
  return abs;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "forge-stale-"));
  savedOverride = process.env[OVERRIDE_ENV];
  delete process.env[OVERRIDE_ENV];
});

afterEach(async () => {
  if (savedOverride === undefined) delete process.env[OVERRIDE_ENV];
  else process.env[OVERRIDE_ENV] = savedOverride;
  await fs.rm(root, { recursive: true, force: true });
});

describe("checkStaleBuild", () => {
  it("reports the source file that is newer than the build", async () => {
    await write("dist/index.js", 1_000_000);
    await write("src/commands/publish.ts", 2_000_000);

    const report = await checkStaleBuild(binary());
    expect(report?.newer).toBe(path.join("src", "commands", "publish.ts"));
  });

  it("says nothing when the build is newer than every source file", async () => {
    await write("src/index.ts", 1_000_000);
    await write("src/commands/publish.ts", 1_500_000);
    await write("dist/index.js", 2_000_000);

    expect(await checkStaleBuild(binary())).toBeNull();
  });

  it("says nothing for an installed package, which has no src/ beside dist/", async () => {
    // The case that matters most: every user who ran `npm i -g` is here, and a
    // refusal they cannot act on would be a worse bug than the one this fixes.
    await write("dist/index.js", 1_000_000);

    expect(await checkStaleBuild(binary())).toBeNull();
  });

  it("finds a change nested several directories deep", async () => {
    await write("dist/index.js", 1_000_000);
    await write("src/a/b/c/deep.ts", 2_000_000);

    expect((await checkStaleBuild(binary()))?.newer).toBe(
      path.join("src", "a", "b", "c", "deep.ts"),
    );
  });

  it("is not fooled by a source file that is merely as old as the build", async () => {
    // Equal mtimes mean the build saw that content — a build writes `dist/`
    // after reading `src/`, so only strictly newer is evidence of a change.
    await write("src/index.ts", 1_000_000);
    await write("dist/index.js", 1_000_000);

    expect(await checkStaleBuild(binary())).toBeNull();
  });

  it("stands down when the override is set", async () => {
    await write("dist/index.js", 1_000_000);
    await write("src/index.ts", 2_000_000);
    process.env[OVERRIDE_ENV] = "1";

    expect(await checkStaleBuild(binary())).toBeNull();
  });

  it("says nothing when the binary itself is missing", async () => {
    await write("src/index.ts", 2_000_000);

    expect(await checkStaleBuild(binary())).toBeNull();
  });
});

describe("staleMessage", () => {
  it("names the file, the rebuild, and the way out", async () => {
    await write("dist/index.js", 1_000_000);
    await write("src/doctor.ts", 2_000_000);
    const report = await checkStaleBuild(binary());
    if (!report) throw new Error("expected a stale report");

    const message = staleMessage(report);
    expect(message).toContain(path.join("src", "doctor.ts"));
    expect(message).toContain("pnpm --filter @forgedesign/cli build");
    expect(message).toContain(OVERRIDE_ENV);
    // The half the creator most needs to know: it is not just this command.
    expect(message).toContain("forge doctor");
  });
});
