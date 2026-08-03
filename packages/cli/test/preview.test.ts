import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listPreviews, startPreview, stopPreview } from "../src/preview.js";

let sandbox: string;
let repo: string;
let fakeServer: string;
/** pids started by tests — force-killed in afterEach so failures never leak servers */
const startedPids: number[] = [];

// Fake dev server: listens on --port and answers HTTP. Stands in for vite —
// tests must never install or run a real dev server.
const FAKE_SERVER = `
import http from "node:http";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
http.createServer((req, res) => res.end(process.env.FORGE_PREVIEW_BRIDGE_CONFIG ?? "fake-preview")).listen(port, "127.0.0.1");
`;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo }).toString().trim();

const command = () => ["node", fakeServer, "--port", "{port}"];

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

beforeEach(async () => {
  sandbox = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "forge-preview-")));
  fakeServer = path.join(sandbox, "fake-server.mjs");
  await fs.writeFile(fakeServer, FAKE_SERVER, "utf8");

  repo = path.join(sandbox, "repo");
  await fs.mkdir(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t.co");
  git("config", "user.name", "T");
  await fs.writeFile(path.join(repo, ".gitignore"), ".forge/\n");
  await fs.writeFile(path.join(repo, "app.txt"), "v1\n");
  git("add", "-A");
  git("commit", "-qm", "seed");
});

afterEach(async () => {
  for (const pid of startedPids.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("preview runner", () => {
  it("creates a detached worktree at the current branch's HEAD and serves on an ephemeral port", async () => {
    const record = await startPreview({
      cwd: repo,
      command: command(),
      dir: ".",
      install: false,
      readyTimeoutMs: 10_000,
    });
    startedPids.push(record.pid);

    expect(record.branch).toBe("main");
    expect(record.worktree).toBe(path.join(repo, ".forge", "preview", "main"));
    expect(record.command).toContain(`--port ${record.port}`);
    expect(record.url).toBe(`http://127.0.0.1:${record.port}`);
    // a real checkout of the branch's commit, separate from the main checkout
    await expect(fs.access(path.join(record.worktree, "app.txt"))).resolves.toBeUndefined();
    expect(await portOpen(record.port)).toBe(true);

    // status sees it running; the main checkout is untouched
    const statuses = await listPreviews(repo);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({ name: "main", running: true, port: record.port });
    expect(git("status", "--porcelain")).toBe("");
  });

  it("reuses a live server instead of starting a second one", async () => {
    const first = await startPreview({
      cwd: repo,
      command: command(),
      dir: ".",
      install: false,
      readyTimeoutMs: 10_000,
    });
    startedPids.push(first.pid);
    const second = await startPreview({
      cwd: repo,
      command: command(),
      dir: ".",
      install: false,
    });
    expect(second.pid).toBe(first.pid);
    expect(second.port).toBe(first.port);
  });

  it("passes an ephemeral bridge configuration only to the launched dev server", async () => {
    const record = await startPreview({
      cwd: repo,
      command: command(),
      dir: ".",
      install: false,
      bridge: {
        protocolVersion: 1,
        dashboardOrigin: "http://127.0.0.1:4400",
        projectId: "project-1",
        exploration: "ignored-by-runner",
        sessionId: "session-1",
        nonce: "0123456789abcdef0123456789abcdef",
      },
      bridgeAdapter: "react-vite",
    });
    startedPids.push(record.pid);

    expect(record.bridge).toEqual({
      protocolVersion: 1,
      dashboardOrigin: "http://127.0.0.1:4400",
      projectId: "project-1",
      exploration: "main",
      sessionId: "session-1",
      nonce: "0123456789abcdef0123456789abcdef",
      previewOrigin: record.url,
    });
    expect(record.bridgeAdapter).toBe("react-vite");
    expect(record.command).not.toContain("0123456789abcdef");
  });

  it("refuses malformed bridge routing before it can reach a dev server", async () => {
    await expect(
      startPreview({
        cwd: repo,
        command: command(),
        dir: ".",
        install: false,
        bridge: {
          protocolVersion: 1,
          dashboardOrigin: "http://localhost:4400/path",
          projectId: "project-1",
          exploration: "main",
          sessionId: "session-1",
          nonce: "not-a-128-bit-nonce",
        },
        bridgeAdapter: "react-vite",
      }),
    ).rejects.toThrow("invalid Preview Bridge launch configuration");
  });

  it("stopPreview kills the server and clears the record, keeping the worktree", async () => {
    const record = await startPreview({
      cwd: repo,
      command: command(),
      dir: ".",
      install: false,
      readyTimeoutMs: 10_000,
    });
    startedPids.push(record.pid);

    const { stopped } = await stopPreview({ name: "main", cwd: repo });
    expect(stopped).toBe(true);
    expect(await portOpen(record.port)).toBe(false);
    expect(await listPreviews(repo)).toEqual([]);
    // worktree kept for fast restart
    await expect(fs.access(record.worktree)).resolves.toBeUndefined();

    // --remove-worktree cleans it
    await stopPreview({ name: "main", cwd: repo, removeWorktree: true });
    await expect(fs.access(record.worktree)).rejects.toThrow();
  });

  it("cleans up orphaned records for dead servers", async () => {
    const record = await startPreview({
      cwd: repo,
      command: command(),
      dir: ".",
      install: false,
      readyTimeoutMs: 10_000,
    });
    startedPids.push(record.pid);
    // simulate a crash/reboot: the process dies but the record stays
    process.kill(-record.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));

    const statuses = await listPreviews(repo);
    expect(statuses[0]).toMatchObject({ name: "main", running: false });
    // record was removed from disk — a second listing is empty
    expect(await listPreviews(repo)).toEqual([]);
  });

  it("reports a live pid whose port went silent as not running, and keeps the record", async () => {
    // Pids are reused, and a wedged dev server keeps its own. What callers do
    // with a "running" preview is open its URL, so the port is what decides.
    const record = await startPreview({
      cwd: repo,
      command: command(),
      dir: ".",
      install: false,
      readyTimeoutMs: 10_000,
    });
    startedPids.push(record.pid);
    expect((await listPreviews(repo))[0]).toMatchObject({ running: true });

    // Point the record at a port nothing is listening on, leaving the pid alive
    // — the shape of a reused pid.
    const metaPath = path.join(repo, ".forge", "preview", "main.json");
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    await fs.writeFile(metaPath, JSON.stringify({ ...meta, port: 1 }), "utf8");

    const statuses = await listPreviews(repo);
    expect(statuses[0]).toMatchObject({ name: "main", running: false });
    // the record survives: it is the only handle stopPreview has on that process
    await expect(fs.access(metaPath)).resolves.toBeUndefined();
  });

  it("refuses a detached HEAD, and reports a command that dies before ready", async () => {
    // There is no branch to name the preview after, so there is nothing to preview.
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim();
    execFileSync("git", ["checkout", "-q", "--detach", head], { cwd: repo });
    await expect(startPreview({ cwd: repo, command: command(), dir: "." })).rejects.toThrow(
      /detached HEAD/,
    );
    execFileSync("git", ["checkout", "-q", "main"], { cwd: repo });

    await expect(
      startPreview({
        cwd: repo,
        command: ["node", "-e", "process.exit(3)"],
        dir: ".",
        install: false,
        readyTimeoutMs: 5000,
      }),
    ).rejects.toThrow(/exited before becoming ready/);
  });
});
