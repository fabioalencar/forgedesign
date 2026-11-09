import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFileAtomic } from "../src/atomic-write.js";
import { configPath, writeUserConfig } from "../src/config.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "forge-atomic-")));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const modeOf = async (file: string) => (await fs.stat(file)).mode & 0o777;

describe("writeFileAtomic (TASK-535)", () => {
  it("replaces the file whole and leaves nothing beside it", async () => {
    const file = path.join(dir, "freezes.json");
    await fs.writeFile(file, "[]\n", "utf8");

    await writeFileAtomic(file, '[{"tag":"v1"}]\n');

    expect(await fs.readFile(file, "utf8")).toBe('[{"tag":"v1"}]\n');
    expect(await fs.readdir(dir)).toEqual(["freezes.json"]);
  });

  it("never lets a reader see a partly written file", async () => {
    const file = path.join(dir, "projects.json");
    // Big enough that a plain write is caught half-done by a concurrent read.
    const payload = (n: number) =>
      `${JSON.stringify({ projects: Array.from({ length: 20_000 }, (_, i) => ({ n, i })) })}\n`;
    await writeFileAtomic(file, payload(0));

    let writing = true;
    const writes = (async () => {
      for (let n = 1; n <= 20; n += 1) await writeFileAtomic(file, payload(n));
      writing = false;
    })();
    const failures: string[] = [];
    while (writing) {
      const text = await fs.readFile(file, "utf8");
      try {
        JSON.parse(text);
      } catch {
        failures.push(`read ${text.length} bytes that were not JSON`);
      }
    }
    await writes;

    expect(failures).toEqual([]);
  });

  it("keeps an existing file's mode when none is given, and sets one exactly when it is", async () => {
    const kept = path.join(dir, "kept.md");
    await fs.writeFile(kept, "a", "utf8");
    await fs.chmod(kept, 0o640);
    await writeFileAtomic(kept, "b");
    expect(await modeOf(kept)).toBe(0o640);

    const secret = path.join(dir, "secret.json");
    await fs.writeFile(secret, "{}", "utf8");
    await fs.chmod(secret, 0o644);
    await writeFileAtomic(secret, "{}", { mode: 0o600 });
    expect(await modeOf(secret)).toBe(0o600);
  });

  it("writes where a symlink points and leaves the link in place", async () => {
    const real = path.join(dir, "real.json");
    const link = path.join(dir, "link.json");
    await fs.writeFile(real, "old", "utf8");
    await fs.symlink(real, link);

    await writeFileAtomic(link, "new");

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(real, "utf8")).toBe("new");
  });
});

describe("the user config holds a token, so it is 0600 whatever it was before (TASK-535)", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.FORGE_HOME;
    process.env.FORGE_HOME = path.join(dir, ".forge");
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.FORGE_HOME;
    else process.env.FORGE_HOME = previousHome;
  });

  it("narrows a config that was world-readable", async () => {
    await fs.mkdir(path.dirname(configPath()), { recursive: true });
    await fs.writeFile(configPath(), "{}\n", "utf8");
    await fs.chmod(configPath(), 0o644);

    await writeUserConfig({ cloudToken: "tok" });

    expect(await modeOf(configPath())).toBe(0o600);
    expect(JSON.parse(await fs.readFile(configPath(), "utf8"))).toEqual({ cloudToken: "tok" });
  });
});
