import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFreeze } from "../src/commands/freeze.js";
import { initProject } from "../src/commands/init.js";
import { readFreezes } from "../src/freezes.js";

let sandbox: string;
let previousForgeHome: string | undefined;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-freeze-"));
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

const mkdirWrite = (dir: string, file: string) =>
  `node -e "const fs=require('fs');fs.mkdirSync('${dir}',{recursive:true});fs.writeFileSync('${dir}/${file}','<html><head></head><body>ok</body></html>')"`;

/** Design repo with instant stub builds so freeze tests don't npm-install. */
async function makeDesignRepo(name = "demo"): Promise<string> {
  const root = path.join(sandbox, name);
  await initProject(root);
  // init scaffolds the record only (DDR-050); a buildable prototype is this
  // fixture's own business.
  await fs.mkdir(path.join(root, "prototype"), { recursive: true });
  // ...including ignoring its build outputs, so a freeze leaves a clean tree.
  await fs.appendFile(
    path.join(root, ".gitignore"),
    "prototype/dist/\nprototype/storybook-static/\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "prototype/package.json"),
    JSON.stringify({
      name: `${name}-prototype`,
      private: true,
      scripts: {
        build: mkdirWrite("dist", "index.html"),
        "build-storybook": mkdirWrite("storybook-static", "index.html"),
      },
    }),
    "utf8",
  );
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("add", "-A");
  git("commit", "-m", "seed");
  return root;
}

describe("runFreeze", () => {
  it("tags, builds, writes freezes.json, and commits — leaving a clean tree", async () => {
    const root = await makeDesignRepo();
    const result = await runFreeze({
      tag: "alpha",
      message: "first stakeholder round",
      cwd: root,
    });

    const git = (...args: string[]) => execFileSync("git", args, { cwd: root }).toString().trim();
    expect(git("cat-file", "-t", "alpha")).toBe("tag"); // annotated, not lightweight
    expect(git("tag", "-l", "--format=%(contents:subject)", "alpha")).toBe(
      "first stakeholder round",
    );
    expect(git("status", "--porcelain")).toBe("");
    expect(git("log", "-1", "--format=%s")).toBe("Freeze alpha: first stakeholder round");

    const [entry] = await readFreezes(root);
    expect(entry).toMatchObject({ tag: "alpha", previewUrl: null, storybookUrl: null });
    // No PIN: it is Cloud's to mint and Cloud's to keep (TASK-447, DDR-115), and
    // this file is committed.
    expect(entry?.pin).toBeUndefined();
    expect(entry?.commit).toBe(git("rev-parse", "alpha^{commit}"));
    expect(result.record.tag).toBe("alpha");
    // Every built route's content hash rides on the freeze (TASK-461), so a
    // later freeze can say which screens changed without rebuilding this one.
    expect(entry?.routes).toEqual({ "/": expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });

    await expect(fs.access(path.join(root, "prototype/dist/index.html"))).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(root, "prototype/storybook-static/index.html")),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, "hub/index.html"))).resolves.toBeUndefined();
    expect(git("ls-files", "hub")).toContain("hub/index.html");
  });

  it("mints the project identity even with no comment API configured (TASK-416)", async () => {
    // FORGE_HOME here holds no config.json, so this is a creator who has only
    // signed in to Cloud. Minting used to sit inside the comment-API branch, so
    // this freeze succeeded and left no projectId — and `forge publish` then
    // refused with "no projectId in forge.json — freeze once first", advice
    // that no amount of freezing could satisfy. The paid path was unreachable
    // for exactly the users who had never configured the legacy comment API.
    const root = await makeDesignRepo();
    await runFreeze({ tag: "alpha", message: "first cut", cwd: root });

    const manifest = JSON.parse(await fs.readFile(path.join(root, "forge.json"), "utf8"));
    expect(manifest.projectId).toMatch(/^[0-9a-f-]{36}$/);
    // Committed with the freeze, not left dirty: the id is part of what the
    // freeze commit carries.
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root }).toString().trim();
    expect(git("status", "--porcelain")).toBe("");
    expect(git("show", "HEAD:forge.json")).toContain(manifest.projectId);
  });

  it("keeps that identity stable across freezes", async () => {
    const root = await makeDesignRepo();
    const read = async () =>
      JSON.parse(await fs.readFile(path.join(root, "forge.json"), "utf8")).projectId;
    await runFreeze({ tag: "alpha", message: "a", cwd: root });
    const first = await read();
    await runFreeze({ tag: "beta", message: "b", cwd: root });
    expect(await read()).toBe(first);
  });

  it("supports repeated freezes with distinct tags", async () => {
    const root = await makeDesignRepo();
    await runFreeze({ tag: "alpha", message: "a", cwd: root });
    await runFreeze({ tag: "beta", message: "b", cwd: root });
    expect((await readFreezes(root)).map((f) => f.tag)).toEqual(["alpha", "beta"]);
    const hub = await fs.readFile(path.join(root, "hub/index.html"), "utf8");
    expect(hub.indexOf(">beta<")).toBeLessThan(hub.indexOf(">alpha<"));
  });

  it("refuses a dirty working tree and creates no tag", async () => {
    const root = await makeDesignRepo();
    await fs.writeFile(path.join(root, "scratch.txt"), "wip", "utf8");

    await expect(runFreeze({ tag: "alpha", message: "x", cwd: root })).rejects.toThrow(/not clean/);
    const tags = execFileSync("git", ["tag"], { cwd: root }).toString().trim();
    expect(tags).toBe("");
  });

  it("refuses an existing tag", async () => {
    const root = await makeDesignRepo();
    await runFreeze({ tag: "alpha", message: "x", cwd: root });
    await expect(runFreeze({ tag: "alpha", message: "y", cwd: root })).rejects.toThrow(
      /already exists/,
    );
  });

  it("refuses an empty message", async () => {
    const root = await makeDesignRepo();
    await expect(runFreeze({ tag: "alpha", message: "  ", cwd: root })).rejects.toThrow(
      /--message/,
    );
  });

  it("rolls back the tag when the build fails", async () => {
    const root = await makeDesignRepo();
    const pkgPath = path.join(root, "prototype/package.json");
    const pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"));
    pkg.scripts.build = 'node -e "process.exit(1)"';
    await fs.writeFile(pkgPath, JSON.stringify(pkg), "utf8");
    execFileSync("git", ["commit", "-am", "break build"], { cwd: root });

    await expect(runFreeze({ tag: "alpha", message: "x", cwd: root })).rejects.toThrow(
      /build failed/,
    );
    const tags = execFileSync("git", ["tag"], { cwd: root }).toString().trim();
    expect(tags).toBe("");
    expect(await readFreezes(root)).toEqual([]);
  });
});

describe("freeze on a record that is not current (TASK-395)", () => {
  it("refuses before creating the tag", async () => {
    // DDR-095 says a pre-0.2 record gets `upgrade` and nothing else, and freeze
    // was missed when that landed — it writes the feature log and stamps the
    // resolution trail, so it is a writer. Refusing *before* the tag matters:
    // an annotated tag left behind by a half-run freeze is what the
    // immutability check then refuses on the retry.
    const root = path.join(sandbox, "legacy");
    await fs.mkdir(root, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });
    await fs.writeFile(path.join(root, "forge.json"), '{"formatVersion":"0.1"}\n', "utf8");
    await fs.writeFile(path.join(root, "Todos.md"), "## Todo\n", "utf8");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.name=a", "-c", "user.email=a@b", "commit", "-qm", "seed"], {
      cwd: root,
    });

    await expect(runFreeze({ tag: "v1", message: "x", cwd: root })).rejects.toThrow(
      /forge upgrade --to 0\.2/,
    );
    expect(execFileSync("git", ["tag"], { cwd: root, encoding: "utf8" }).trim()).toBe("");
  });
});
