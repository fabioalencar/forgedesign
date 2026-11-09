import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeBundleIndex } from "../src/bundle-index.js";
import { runFreeze } from "../src/freeze-ceremony.js";
import { makeDesignRepo } from "./helpers.js";

// `forge freeze` tells Cloud what a release addressed only once the release's
// commit exists (TASK-547, DDR-159). The stand-in service records, at the
// moment it is told, which commit the repo was on — so a push made before the
// freeze commit shows up as the wrong commit, not as a race nobody can see.

const SNAPSHOT_ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const COMMENT = "11111111-1111-4111-8111-111111111111";

let sandbox: string;
let repo: string;
let server: http.Server;
let resolveStatus: number;
let told: Array<{ headSubject: string; resolutions: unknown[] }>;
let previousForgeHome: string | undefined;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "forge-freeze-trail-")));
  previousForgeHome = process.env.FORGE_HOME;
  process.env.FORGE_HOME = path.join(sandbox, ".forge");
  told = [];
  resolveStatus = 200;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      if (req.url !== "/comments/resolve") {
        res.statusCode = 404;
        return void res.end("{}");
      }
      res.statusCode = resolveStatus;
      if (resolveStatus !== 200) return void res.end(JSON.stringify({ error: "db is down" }));
      const payload = JSON.parse(raw) as { resolutions: unknown[] };
      told.push({ headSubject: git("log", "-1", "--format=%s"), resolutions: payload.resolutions });
      res.end(JSON.stringify({ resolved: payload.resolutions.length }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await fs.mkdir(process.env.FORGE_HOME as string, { recursive: true });
  await fs.writeFile(
    path.join(process.env.FORGE_HOME as string, "config.json"),
    JSON.stringify({ commentsApiUrl: base, commentsApiKey: "sk-test" }),
  );

  // A record mid-loop: alpha was reviewed, one comment became TASK-001, and
  // TASK-001 is done — so the next freeze is the release that addresses it.
  repo = await makeDesignRepo(sandbox);
  await fs.writeFile(
    path.join(repo, "freezes.json"),
    JSON.stringify([
      {
        tag: "alpha",
        date: "2026-07-04",
        commit: "a",
        previewUrl: null,
        storybookUrl: null,
        snapshotId: SNAPSHOT_ID,
      },
    ]),
  );
  await fs.writeFile(
    path.join(repo, "design", "todos.md"),
    "---\ntype: Task Ledger\ntitle: Todos\n---\n## Todo\n\n## Doing\n\n## Done\n- [x] TASK-001 Reduce header weight\n  status: done · opened: 2026-07-05\n\n## Deferred\n",
  );
  await fs.mkdir(path.join(repo, "design", "feedback"), { recursive: true });
  await fs.writeFile(
    path.join(repo, "design", "feedback", "FEEDBACK-001.md"),
    `---\ntype: Feedback\nid: FEEDBACK-001\ntitle: The header feels heavy\ndate: 2026-07-04\nfeedback_status: accepted\nsource: review\nfreeze: FREEZE-001\nfrom: PM\nresolution: TASK-001\ncomment: ${COMMENT}\n---\n> the header feels heavy\n`,
  );
  await writeBundleIndex(repo);
  git("add", "-A");
  git("commit", "-qm", "alpha reviewed; TASK-001 done");
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (previousForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = previousForgeHome;
  await fs.rm(sandbox, { recursive: true, force: true });
});

const committedFeedback = () => git("show", "HEAD:design/feedback/FEEDBACK-001.md");

describe("freeze tells Cloud after its commit, never before (TASK-547)", () => {
  it("commits the stamp, then tells the service, with the freeze commit already made", async () => {
    await runFreeze({ tag: "v2", message: "lighter header", cwd: repo });

    expect(committedFeedback()).toContain("addressed_in: v2");
    expect(told).toHaveLength(1);
    expect(told[0]?.headSubject).toBe("Freeze v2: lighter header");
    expect(told[0]?.resolutions).toContainEqual(
      expect.objectContaining({ commentId: COMMENT, status: "addressed", resolvedInTag: "v2" }),
    );
  });

  it("tells the service nothing when the freeze fails at its commit", async () => {
    const hook = path.join(repo, ".git", "hooks", "pre-commit");
    await fs.writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });

    await expect(runFreeze({ tag: "v2", message: "lighter header", cwd: repo })).rejects.toThrow();

    expect(told).toEqual([]);
    expect(git("tag", "-l", "v2")).toBe("");
    expect(
      await fs.readFile(path.join(repo, "design", "feedback", "FEEDBACK-001.md"), "utf8"),
    ).not.toContain("addressed_in");
  });

  it("finishes the freeze when the service refuses, and says the next run tells it", async () => {
    resolveStatus = 500;

    const result = await runFreeze({ tag: "v2", message: "lighter header", cwd: repo });

    expect(git("tag", "-l", "v2")).toBe("v2");
    expect(committedFeedback()).toContain("addressed_in: v2");
    expect(result.warnings.join(" ")).toContain("resolution sync failed");
    expect(result.warnings.join(" ")).toContain("forge comments resolve v2");
  });
});
