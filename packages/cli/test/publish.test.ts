import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectBuild,
  collectRecord,
  contentTypeFor,
  oversizeRefusal,
  PUBLISH_BODY_LIMIT,
  publishBuild,
  type RecordSnapshot,
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

// A real server, as in cloud-auth.test.ts: what matters is which requests were
// made, in what order, and what the CLI says about each answer.
type Call = { method: string; path: string; type: string | undefined; body: Buffer };
type Answer = { code: number; type?: string; body?: string };

let server: http.Server;
let base: string;
let calls: Call[];
let route: (call: Call) => Answer;
const savedHome = process.env.FORGE_HOME;

const json = (body: unknown, code = 200): Answer => ({
  code,
  type: "application/json",
  body: JSON.stringify(body),
});
const RESULT = { url: "u", slug: "s", tag: "v1", fileCount: 1, freezesUsed: 1 };

async function startServer() {
  calls = [];
  route = () => json({});
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const call = {
        method: req.method ?? "",
        path: req.url ?? "",
        type: req.headers["content-type"],
        body: Buffer.concat(chunks),
      };
      calls.push(call);
      const { code, type = "text/plain", body = "" } = route(call);
      res.statusCode = code;
      res.setHeader("Content-Type", type);
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.FORGE_HOME = path.join(root, "home");
  await write("home/config.json", JSON.stringify({ cloudApiUrl: base, cloudToken: "t" }));
}

async function stopServer() {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  if (savedHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = savedHome;
}

const publish = (force?: boolean, extra: { message?: string } = {}) =>
  publishBuild({
    buildDir: path.join(root, "dist"),
    projectId: "p",
    repoName: "r",
    tag: "v1",
    force,
    ...extra,
  });

const sent = (method: string, prefix: string) =>
  calls.filter((c) => c.method === method && c.path.startsWith(prefix));

describe("against the website's single-body publish (TASK-522)", () => {
  beforeEach(startServer);
  afterEach(stopServer);

  it("asks how the server takes a publish, then refuses before sending a body over the limit", async () => {
    await write("dist/index.html", "<h1>hi</h1>");
    await fs.mkdir(path.join(root, "dist/media"), { recursive: true });
    await fs.writeFile(path.join(root, "dist/media/hero.mp4"), randomBytes(3_500_000));

    for (const force of [undefined, true]) {
      const outcome = await publish(force);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.refusal.error).toContain("at most 4.5 MB");
      expect(outcome.refusal.error).toContain("media/hero.mp4");
    }
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "GET /api/cli/me",
      "GET /api/cli/me",
    ]);
  });

  it("still sends a build under the limit, as one body", async () => {
    await write("dist/index.html", "<h1>hi</h1>");
    route = (call) =>
      call.path === "/api/cli/publish" ? json(RESULT) : json({ email: "a@b.c", plan: "pro" });
    const outcome = await publish();
    expect(outcome.ok).toBe(true);
    const [body] = sent("POST", "/api/cli/publish").map((c) => JSON.parse(c.body.toString()));
    expect(body.files[0]).toMatchObject({
      path: "index.html",
      content: Buffer.from("<h1>hi</h1>").toString("base64"),
    });
  });

  it("turns the host's own 413 into the same plain refusal", async () => {
    await write("dist/index.html", "<h1>hi</h1>");
    route = (call) =>
      call.path === "/api/cli/publish"
        ? { code: 413, body: "Request Entity Too Large\n\nFUNCTION_PAYLOAD_TOO_LARGE\n" }
        : json({});
    const outcome = await publish();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.error).toContain("Forge Cloud takes at most");
    expect(outcome.refusal.error).not.toContain("FUNCTION_PAYLOAD_TOO_LARGE");
  });

  it("names the five largest files, largest first", () => {
    const f = (p: string, bytes: number) => ({
      path: p,
      content: Buffer.alloc(bytes).toString("base64"),
      contentType: "application/octet-stream",
    });
    const message = oversizeRefusal(PUBLISH_BODY_LIMIT + 1, [
      f("a.png", 100),
      f("b.mp4", 2_000_000),
      f("c.png", 300_000),
      f("d.png", 400_000),
      f("e.png", 500_000),
      f("f.png", 600_000),
    ]);
    const listed = message.split("\n").filter((line) => /^\s+\d+\.\d MB {2}/.test(line));
    expect(listed.map((line) => line.trim().split(/\s+/).at(-1))).toEqual([
      "b.mp4",
      "f.png",
      "e.png",
      "d.png",
      "c.png",
    ]);
    expect(message).toContain("3.8 MB;");
  });
});

describe("against Cloud's staged publish (DDR-153, DDR-154)", () => {
  beforeEach(startServer);
  afterEach(stopServer);

  const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

  /** Cloud as the CLI meets it: me says staged, open presigns a URL per file, commit answers. */
  function cloud(upload: (call: Call, attempt: number) => Answer = () => ({ code: 200 })) {
    const attempts = new Map<string, number>();
    route = (call) => {
      if (call.path === "/api/cli/me")
        return json({ email: "a@b.c", plan: "pro", publish: "staged" });
      if (call.path === "/api/cli/publish") {
        const opened = JSON.parse(call.body.toString()) as {
          files: { path: string; contentType: string }[];
          record: { path: string; contentType: string }[];
        };
        const presign = (kind: string) => (f: { path: string; contentType: string }) => ({
          kind,
          path: f.path,
          contentType: f.contentType,
          url: `${base}/upload/${kind}/${f.path}`,
        });
        return json({
          uploadId: "u1",
          uploads: [...opened.files.map(presign("build")), ...opened.record.map(presign("record"))],
        });
      }
      if (call.path.startsWith("/upload/")) {
        const n = (attempts.get(call.path) ?? 0) + 1;
        attempts.set(call.path, n);
        return upload(call, n);
      }
      if (call.path === "/api/cli/publish/commit") return json(RESULT);
      return { code: 404 };
    };
  }

  it("declares sizes and hashes, uploads each file's bytes with its type, then commits", async () => {
    cloud();
    await write("dist/index.html", "<h1>hi</h1>");
    await write("dist/assets/app.css", "body{}");
    const record: RecordSnapshot = {
      files: [
        {
          path: "brief.md",
          content: Buffer.from("# Brief").toString("base64"),
          contentType: "text/markdown; charset=utf-8",
        },
      ],
      kept: 1,
      withheld: 0,
    };
    const outcome = await publishBuild({
      buildDir: path.join(root, "dist"),
      projectId: "p",
      repoName: "r",
      tag: "v1",
      record,
      message: "First round",
    });
    expect(outcome).toEqual({ ok: true, result: RESULT });

    const [opened] = sent("POST", "/api/cli/publish").map((c) => JSON.parse(c.body.toString()));
    expect(opened).toMatchObject({
      projectId: "p",
      repoName: "r",
      tag: "v1",
      message: "First round",
    });
    expect(opened.files).toEqual([
      {
        path: "assets/app.css",
        size: 6,
        sha256: sha("body{}"),
        contentType: "text/css; charset=utf-8",
      },
      {
        path: "index.html",
        size: 11,
        sha256: sha("<h1>hi</h1>"),
        contentType: "text/html; charset=utf-8",
      },
    ]);
    expect(opened.record).toEqual([
      {
        path: "brief.md",
        size: 7,
        sha256: sha("# Brief"),
        contentType: "text/markdown; charset=utf-8",
      },
    ]);

    const puts = sent("PUT", "/upload/");
    expect(puts.map((c) => [c.path, c.type, c.body.toString()]).sort()).toEqual([
      ["/upload/build/assets/app.css", "text/css; charset=utf-8", "body{}"],
      ["/upload/build/index.html", "text/html; charset=utf-8", "<h1>hi</h1>"],
      ["/upload/record/brief.md", "text/markdown; charset=utf-8", "# Brief"],
    ]);
    expect(
      sent("POST", "/api/cli/publish/commit").map((c) => JSON.parse(c.body.toString())),
    ).toEqual([{ uploadId: "u1" }]);
    const order = calls.map((c) => c.path);
    expect(order.indexOf("/api/cli/publish/commit")).toBe(order.length - 1);
  });

  it("publishes a build the single body could not carry", async () => {
    cloud();
    await write("dist/index.html", "<h1>hi</h1>");
    await fs.mkdir(path.join(root, "dist/media"), { recursive: true });
    await fs.writeFile(path.join(root, "dist/media/hero.mp4"), randomBytes(3_500_000));
    const outcome = await publish();
    expect(outcome.ok).toBe(true);
    expect(sent("PUT", "/upload/build/media/hero.mp4")[0]?.body.byteLength).toBe(3_500_000);
  });

  it("tries a failed upload again, and counts an upload that already landed", async () => {
    cloud((call, attempt) => {
      if (call.path.endsWith("index.html"))
        return attempt === 1 ? { code: 503, body: "busy" } : { code: 200 };
      return { code: 409, body: "already uploaded" };
    });
    await write("dist/index.html", "<h1>hi</h1>");
    await write("dist/app.css", "body{}");
    expect((await publish()).ok).toBe(true);
    expect(sent("PUT", "/upload/build/index.html")).toHaveLength(2);
    expect(sent("PUT", "/upload/build/app.css")).toHaveLength(1);
  });

  it("stops without committing when an upload is refused", async () => {
    cloud(() => ({ code: 403, body: "signature expired" }));
    await write("dist/index.html", "<h1>hi</h1>");
    const outcome = await publish();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.error).toBe("could not upload index.html: HTTP 403 signature expired");
    expect(sent("POST", "/api/cli/publish/commit")).toEqual([]);
  });

  it("passes on Cloud's refusal at open, and stops there", async () => {
    cloud();
    const opened = route;
    route = (call) =>
      call.path === "/api/cli/publish"
        ? json({ error: "v1 is already published — freeze a new tag instead" }, 409)
        : opened(call);
    await write("dist/index.html", "<h1>hi</h1>");
    expect(await publish()).toEqual({
      ok: false,
      refusal: { error: "v1 is already published — freeze a new tag instead" },
    });
    expect(sent("PUT", "/upload/")).toEqual([]);
  });

  it("says to sign in when the token is no longer good, before declaring anything", async () => {
    route = () => json({ error: "unauthorized" }, 401);
    await write("dist/index.html", "<h1>hi</h1>");
    const outcome = await publish();
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusal.error).toContain("forge login");
    expect(calls.map((c) => c.path)).toEqual(["/api/cli/me"]);
  });
});
