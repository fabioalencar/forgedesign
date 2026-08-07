import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectBuild, contentTypeFor, screenPublishHazards } from "../src/publish.js";

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
