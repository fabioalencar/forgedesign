import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectBuild,
  collectRecord,
  contentTypeFor,
  screenPublishHazards,
} from "../src/publish.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "forge-publish-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

describe("contentTypeFor", () => {
  it("types what a static prototype is made of", () => {
    expect(contentTypeFor("index.html")).toBe("text/html; charset=utf-8");
    expect(contentTypeFor("assets/app.css")).toBe("text/css; charset=utf-8");
    expect(contentTypeFor("assets/app.js")).toBe("text/javascript; charset=utf-8");
    expect(contentTypeFor("logo.svg")).toBe("image/svg+xml");
    expect(contentTypeFor("font.woff2")).toBe("font/woff2");
  });

  it("is case-insensitive about the extension", () => {
    expect(contentTypeFor("PHOTO.PNG")).toBe("image/png");
  });

  it("falls back to a type a browser downloads rather than guesses at", () => {
    // Guessing wrong breaks the prototype in the reviewer's browser, not at
    // publish time — the failure would be silent and far from its cause.
    expect(contentTypeFor("data.bin")).toBe("application/octet-stream");
    expect(contentTypeFor("LICENSE")).toBe("application/octet-stream");
  });
});

describe("collectBuild", () => {
  it("walks the whole tree and keeps directory-per-route paths intact", async () => {
    // DDR-072's shape: a route is a directory with an index.html, and the
    // review runtime serves it back at that path.
    await write("index.html", "<h1>home</h1>");
    await write("register/index.html", "<h1>register</h1>");
    await write("v1/items/thing/index.html", "<h1>thing</h1>");
    await write("assets/app.css", "body{}");

    const files = await collectBuild(root);
    expect(files.map((f) => f.path)).toEqual([
      "assets/app.css",
      "index.html",
      "register/index.html",
      "v1/items/thing/index.html",
    ]);
  });

  it("base64-encodes content so binaries survive the trip", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await fs.writeFile(path.join(root, "logo.png"), bytes);

    const [file] = await collectBuild(root);
    expect(file?.contentType).toBe("image/png");
    expect(Buffer.from(file!.content, "base64")).toEqual(bytes);
  });

  it("returns nothing for an empty build rather than publishing an empty site", async () => {
    expect(await collectBuild(root)).toEqual([]);
  });

  it("emits POSIX paths, whatever the host filesystem uses", async () => {
    await write(path.join("deep", "nested", "page", "index.html"), "x");
    const [file] = await collectBuild(root);
    expect(file?.path).toBe("deep/nested/page/index.html");
    expect(file?.path).not.toContain("\\");
  });
});

describe("collectRecord (DDR-129)", () => {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root }).toString().trim();

  /** A record with one concept of each audience, committed and tagged `v1`. */
  async function seedRecord(): Promise<void> {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await write(
      "design/index.md",
      '---\nokf_version: "0.2"\n---\n* everything, owner-only included\n',
    );
    await write("design/log.md", "---\ntype: Log\n---\nchange history\n");
    await write(
      "design/brief.md",
      "---\ntype: Brief\ntitle: The brief\n---\nWhat it is for, at v1.\n",
    );
    await write("design/todos.md", "---\ntype: Task Ledger\ntitle: Todos\n---\n## Todo\n");
    await write(
      "design/decisions/DDR-000-template.md",
      "---\ntype: Decision\nid: DDR-000\ntitle: Title\ndate: YYYY-MM-DD\ndecision_status: draft\n---\n## Decision\n",
    );
    await write(
      "design/decisions/DDR-001-private.md",
      "---\ntype: Decision\nid: DDR-001\ntitle: Kept with the creator\ndate: 2026-09-01\ndecision_status: accepted\n---\n## Decision\nThe alternatives it beat are a client's business.\n",
    );
    await write(
      "design/decisions/DDR-002-shared.md",
      "---\ntype: Decision\nid: DDR-002\ntitle: Shared on purpose\ndate: 2026-09-02\ndecision_status: accepted\naudience: stakeholders\n---\n## Decision\nThe why is the stakeholder's to read.\n",
    );
    await write(
      "design/feedback/FEEDBACK-001.md",
      "---\ntype: Feedback\nid: FEEDBACK-001\ntitle: From a reviewer\ndate: 2026-09-03\nfeedback_status: pending\n---\nAnother stakeholder's request.\n",
    );
    await write(
      "design/glossary/freeze.md",
      "---\ntype: Term\ntitle: Freeze\n---\nAn immutable version.\n",
    );
    await write("design/checks/v1/doctor.json", '{"findings":[]}');
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    git("tag", "-a", "v1", "-m", "first");
  }

  it("sends what stakeholders may see and counts what stayed home", async () => {
    await seedRecord();
    const snapshot = await collectRecord(root, "v1", "design");

    // The brief, the flipped decision and the term cross; the ledger, the
    // owner-only decision and the feedback stay. The template is neither.
    expect(snapshot.files.map((f) => f.path)).toEqual([
      "index.md",
      "brief.md",
      "decisions/DDR-002-shared.md",
      "glossary/freeze.md",
    ]);
    expect(snapshot.kept).toBe(3);
    expect(snapshot.withheld).toBe(3);
    for (const file of snapshot.files)
      expect(file.contentType).toBe("text/markdown; charset=utf-8");
  });

  it("regenerates the index over what crossed rather than sending the bundle's own", async () => {
    await seedRecord();
    const { files } = await collectRecord(root, "v1", "design");
    const index = Buffer.from(files[0]!.content, "base64").toString("utf8");
    // The repo's index names every concept, owner-only ones included — sending
    // it would list what the filter withheld. A regenerated one names only
    // what arrived, and still makes what arrived a bundle.
    expect(index).toContain('okf_version: "0.2"');
    expect(index).toContain("decisions/DDR-002-shared.md");
    expect(index).not.toContain("DDR-001");
    expect(index).not.toContain("owner-only included");
    expect(files.map((f) => f.path)).not.toContain("log.md");
  });

  it("reads the record at the tag, not the working tree", async () => {
    await seedRecord();
    await write(
      "design/brief.md",
      "---\ntype: Brief\ntitle: The brief\n---\nRewritten after the freeze.\n",
    );
    git("commit", "-q", "-am", "the record moved on");

    const { files } = await collectRecord(root, "v1", "design");
    const brief = files.find((f) => f.path === "brief.md")!;
    const text = Buffer.from(brief.content, "base64").toString("utf8");
    expect(text).toContain("at v1.");
    expect(text).not.toContain("Rewritten");
    // Byte for byte — the trailing newline the tag holds is still there.
    expect(text.endsWith("\n")).toBe(true);
  });

  it("is empty for a tag with no record beneath it, and for no tag at all", async () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await write("README.md", "no record yet");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    git("tag", "-a", "v1", "-m", "first");

    expect(await collectRecord(root, "v1", "design")).toEqual({ files: [], kept: 0, withheld: 0 });
    expect(await collectRecord(root, "v9", "design")).toEqual({ files: [], kept: 0, withheld: 0 });
  });

  it("sends no index when nothing crossed, but still says what stayed", async () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await write("design/todos.md", "---\ntype: Task Ledger\ntitle: Todos\n---\n## Todo\n");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    git("tag", "-a", "v1", "-m", "first");

    expect(await collectRecord(root, "v1", "design")).toEqual({ files: [], kept: 0, withheld: 1 });
  });
});

describe("screenPublishHazards (TASK-404 finding 4)", () => {
  const f = (path: string) => ({ path, content: "", contentType: "text/plain" });

  it("flags a git repository, a dependency tree, and an env file", () => {
    const hazards = screenPublishHazards([
      f("index.html"),
      f(".git/HEAD"),
      f("node_modules/left-pad/index.js"),
      f(".env"),
      f("assets/app.js"),
    ]);
    expect(hazards.map((h) => h.path).sort()).toEqual([
      ".env",
      ".git/HEAD",
      "node_modules/left-pad/index.js",
    ]);
  });

  it("flags real env variants but not the placeholder conventions", () => {
    const flagged = screenPublishHazards([
      f(".env.local"),
      f(".env.production"),
      f(".env.example"),
      f(".env.sample"),
      f(".env.template"),
    ]).map((h) => h.path);
    expect(flagged).toEqual([".env.local", ".env.production"]);
  });

  it("leaves legitimate dotfiles a static site carries alone", () => {
    expect(
      screenPublishHazards([
        f(".well-known/security.txt"),
        f(".well-known/apple-app-site-association"),
        f(".nojekyll"),
        f("index.html"),
      ]),
    ).toEqual([]);
  });

  it("says nothing about a clean build", () => {
    expect(screenPublishHazards([f("index.html"), f("assets/app.css")])).toEqual([]);
  });
});
