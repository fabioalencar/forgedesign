import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFreeze } from "../src/commands/freeze.js";
import { readFreezes } from "../src/freezes.js";
import { installFakeVercel, makeDesignRepo } from "./helpers.js";

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

let sandbox: string;
let server: http.Server;
let apiUrl: string;
let captured: CapturedRequest[];
let respondWith: number;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-frz-cmt-"));
  for (const key of ["FORGE_HOME", "PATH", "FAKE_VERCEL_FAIL"]) saved[key] = process.env[key];
  process.env.FORGE_HOME = path.join(sandbox, ".forge");
  process.env.PATH = await installFakeVercel(sandbox);

  captured = [];
  respondWith = 201;
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: string) => (raw += chunk));
    req.on("end", () => {
      captured.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      res.statusCode = respondWith;
      res.setHeader("Content-Type", "application/json");
      res.end(respondWith < 300 ? '{"id":"ok"}' : '{"error":"boom"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  apiUrl = `http://127.0.0.1:${address.port}`;

  await fs.mkdir(process.env.FORGE_HOME!, { recursive: true });
  await fs.writeFile(
    path.join(process.env.FORGE_HOME!, "config.json"),
    JSON.stringify({ commentsApiUrl: apiUrl, commentsApiKey: "sk-test" }),
    "utf8",
  );
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("freeze with comment API configured", () => {
  it("registers the snapshot and records snapshotId, leaving the build untouched", async () => {
    const root = await makeDesignRepo(sandbox);
    const result = await runFreeze({ tag: "alpha", message: "x", cwd: root });

    // The artifact is exactly what the build produced: no toolbar, no overlay
    // asset. Freeze produces and Cloud serves (DDR-073), and injecting here
    // both made a hosted freeze load the toolbar twice (TASK-357) and left a
    // review layer inside a build that is meant to be portable (DDR-072).
    const html = await fs.readFile(path.join(root, "prototype/dist/index.html"), "utf8");
    expect(html).not.toContain('id="forge-overlay-script"');
    expect(html).not.toContain("data-snapshot-id");
    await expect(fs.access(path.join(root, "prototype/dist/forge-overlay.js"))).rejects.toThrow();

    // registration call
    expect(captured).toHaveLength(1);
    const reg = captured[0]!;
    expect(reg.method).toBe("POST");
    expect(reg.url).toBe("/snapshots");
    expect(reg.authorization).toBe("Bearer sk-test");
    expect(reg.body.tag).toBe("alpha");
    expect(reg.body.pin).toMatch(/^\d{6}$/);
    // No URL at freeze time any more: freeze produces and Cloud serves
    // (DDR-073, TASK-334). The snapshot still registers, because the comment
    // API has to know the freeze exists before `forge publish` hosts it.
    expect(reg.body.previewUrl).toBeNull();
    expect(reg.body.id).toBe(result.record.snapshotId);

    // identity + records committed, clean tree
    const forgeJson = JSON.parse(await fs.readFile(path.join(root, "forge.json"), "utf8"));
    expect(reg.body.projectId).toBe(forgeJson.projectId);
    const [entry] = await readFreezes(root);
    expect(entry?.snapshotId).toBe(result.record.snapshotId);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString()).toBe("");
  });

  it("keeps the same projectId across freezes", async () => {
    const root = await makeDesignRepo(sandbox);
    await runFreeze({ tag: "alpha", message: "a", cwd: root });
    await runFreeze({ tag: "beta", message: "b", cwd: root });
    expect(captured[0]!.body.projectId).toBe(captured[1]!.body.projectId);
  });

  it("rolls back the tag, and restores forge.json rather than deleting it", async () => {
    // This asserted deletion, which was the bug: `initProject` writes
    // forge.json, so freeze had only *added* a projectId to a file the user
    // owns — and rollback removed the whole thing, build config and all
    // (TASK-335).
    const root = await makeDesignRepo(sandbox);
    const manifestPath = path.join(root, "forge.json");
    const before = await fs.readFile(manifestPath, "utf8");
    respondWith = 500;

    await expect(runFreeze({ tag: "alpha", message: "x", cwd: root })).rejects.toThrow(
      /snapshot registration failed/,
    );
    expect(execFileSync("git", ["tag"], { cwd: root }).toString().trim()).toBe("");
    expect(await fs.readFile(manifestPath, "utf8")).toBe(before);
    expect(await readFreezes(root)).toEqual([]);
  });

  it("removes forge.json on rollback only when it created the file", async () => {
    const root = await makeDesignRepo(sandbox);
    const manifestPath = path.join(root, "forge.json");
    await fs.rm(manifestPath);
    // freeze refuses a dirty tree, so the removal has to be committed first
    execFileSync("git", ["commit", "-am", "drop manifest"], { cwd: root });
    respondWith = 500;

    await expect(runFreeze({ tag: "alpha", message: "x", cwd: root })).rejects.toThrow(
      /snapshot registration failed/,
    );
    await expect(fs.access(manifestPath)).rejects.toThrow();
  });

  it("skips overlay and registration with a warning when unconfigured", async () => {
    await fs.rm(path.join(process.env.FORGE_HOME!, "config.json"));
    const root = await makeDesignRepo(sandbox);
    const result = await runFreeze({ tag: "alpha", message: "x", cwd: root });

    expect(result.warnings.join(" ")).toContain("comment overlay skipped");
    expect(result.record.snapshotId).toBeNull();
    expect(captured).toHaveLength(0);
    const html = await fs.readFile(path.join(root, "prototype/dist/index.html"), "utf8");
    expect(html).not.toContain("forge-overlay-script");
  });
});
