import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readJsonFile } from "../src/json-file.js";
import { readRegistry } from "../src/registry.js";
import { CLI_VERSION } from "../src/version.js";

let dir: string;
let previousHome: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "forge-json-file-"));
  previousHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = dir;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = previousHome;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("readJsonFile, the one reader of the state files (TASK-542)", () => {
  it("is undefined for a missing file, the value for a present one", async () => {
    const file = path.join(dir, "state.json");
    expect(await readJsonFile(file)).toBeUndefined();
    await fs.writeFile(file, '{"a":[1]}\n', "utf8");
    expect(await readJsonFile(file)).toEqual({ a: [1] });
  });

  it("names a malformed file rather than throwing a bare parser error", async () => {
    const file = path.join(dir, "freezes.json");
    await fs.writeFile(file, "[{ broken", "utf8");
    await expect(readJsonFile(file)).rejects.toThrow(
      `${file} is not valid JSON — fix or delete it (`,
    );
  });

  it("leaves the shape to the reader: a registry that is not an object reads as empty", async () => {
    // It used to read `null.projects` and throw a TypeError naming nothing.
    await fs.writeFile(path.join(dir, "projects.json"), "null\n", "utf8");
    expect(await readRegistry()).toEqual({ projects: [] });
  });
});

describe("the version is written once (TASK-542)", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(
      readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
        "utf8",
      ),
    ) as { version: string };
    expect(CLI_VERSION).toBe(pkg.version);
  });
});
