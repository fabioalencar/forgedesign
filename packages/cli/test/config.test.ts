import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readUserConfig } from "../src/config.js";

// FORGE_HOME redirects ~/.forge, so these never touch the real config.
let home: string;
let prev: string | undefined;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(tmpdir(), "forge-config-"));
  prev = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
});

afterEach(async () => {
  if (prev === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = prev;
  await fs.rm(home, { recursive: true, force: true });
});

describe("readUserConfig", () => {
  it("is empty, not an error, when no config exists yet", async () => {
    expect(await readUserConfig()).toEqual({});
  });

  it("reads a valid config", async () => {
    await fs.writeFile(path.join(home, "config.json"), '{ "cloudToken": "abc" }', "utf8");
    expect(await readUserConfig()).toEqual({ cloudToken: "abc" });
  });

  it("names the file and how to fix it rather than crashing on a hand-edit typo", async () => {
    // The whole point: a typo'd config must not answer every Cloud command with a
    // bare parser message naming no file (TASK-411).
    await fs.writeFile(path.join(home, "config.json"), '{ "cloudToken": "x",, }', "utf8");
    await expect(readUserConfig()).rejects.toThrow(
      /config\.json is not valid JSON — fix or delete/,
    );
  });
});
