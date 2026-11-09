import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileAtRef, filesAtRef } from "../src/git.js";

let root: string;

const git = (...args: string[]) =>
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

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "forge-git-"));
  git("init", "-q");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("filesAtRef (TASK-533)", () => {
  it("reads many files at a ref in one batch, byte for byte, the same as fileAtRef", async () => {
    const files: Record<string, string> = {
      "a.md": "first\n",
      "dir/b.md": "naïve — café ✓\n\n",
      "with space.md": "no trailing newline",
      "empty.md": "",
      "multi\nline.md": "a name git allows and the batch protocol cannot frame\n",
    };
    for (const [relPath, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(root, relPath)), { recursive: true });
      await fs.writeFile(path.join(root, relPath), content, "utf8");
    }
    git("add", "-A");
    git("commit", "-qm", "seed");
    // A later edit must not leak in: the answer is the ref's, not the tree's.
    await fs.writeFile(path.join(root, "a.md"), "edited\n", "utf8");

    const asked = [...Object.keys(files), "missing.md"];
    const read = await filesAtRef(root, "HEAD", asked);

    expect([...read.keys()].sort()).toEqual(Object.keys(files).sort());
    for (const [relPath, content] of Object.entries(files)) {
      expect(read.get(relPath)?.toString("utf8")).toBe(content);
      expect(read.get(relPath)?.equals(await fileAtRef(root, "HEAD", relPath))).toBe(true);
    }
  });

  it("answers nothing for a ref that is not one, rather than reading it as an option", async () => {
    await fs.writeFile(path.join(root, "a.md"), "x\n", "utf8");
    git("add", "-A");
    git("commit", "-qm", "seed");
    const outside = path.join(root, "..", `${path.basename(root)}-written`);

    const read = await filesAtRef(root, `--output=${outside}`, ["a.md"]);

    expect(read.size).toBe(0);
    await expect(fs.access(outside)).rejects.toThrow();
  });
});
