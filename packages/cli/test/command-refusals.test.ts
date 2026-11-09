import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Every refusal a command makes, as the person running it sees it: the exact
// stderr and the exit code (TASK-541). Written when the commands moved from
// printing and setting `process.exitCode` to throwing a CliError (DDR-157),
// from the built bin's output before that change, which these reproduce
// byte for byte. Most of these commands had no test before: publish, login,
// skills, upgrade, adopt, index, question, task, dash.
//
// The bin runs from `dist/` exactly as a user runs it, and the staleness guard
// (DDR-099) refuses a stale build — so these fail loudly rather than test old
// code. `HOME` and `FORGE_HOME` point into the sandbox, and a local server
// stands in for Forge Cloud.

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

let work: string;
let base: string;
let server: http.Server;
const fixtures = { empty: "", rec: "", noId: "", noBuild: "", full: "" };

function run(cwd: string, args: string[], env: Record<string, string>) {
  return new Promise<{ status: number | null; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: path.join(work, "home"),
        FORGE_HOME: path.join(work, "forge-home"),
        ...env,
      },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) =>
      resolve({ status, stderr: stderr.replaceAll(work, "<work>").replaceAll(base, "<base>") }),
    );
  });
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      ...args,
    ],
    { cwd, stdio: "pipe" },
  );

async function frozen(name: string, manifest: Record<string, unknown>): Promise<string> {
  const dir = path.join(work, name);
  await fs.cp(fixtures.rec, dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "forge.json"),
    `${JSON.stringify({ formatVersion: "0.2", recordRoot: "design", ...manifest }, null, 2)}\n`,
  );
  await fs.writeFile(
    path.join(dir, "freezes.json"),
    JSON.stringify([
      {
        tag: "v1",
        date: "2026-10-12",
        commit: "x",
        previewUrl: null,
        storybookUrl: null,
        snapshotId: null,
      },
    ]),
  );
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  await fs.writeFile(path.join(dir, "dist", "index.html"), "<p>ok</p>");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "frozen");
  git(dir, "tag", "-a", "v1", "-m", "v1");
  return dir;
}

async function signedInHome(): Promise<string> {
  const dir = path.join(work, `forge-home-signed-${Math.random().toString(36).slice(2)}`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "config.json"),
    JSON.stringify({ cloudToken: "tok", cloudApiUrl: `${base}/refuse` }),
  );
  return dir;
}
let signedInDir = "";
const signedIn = () => signedInDir;

beforeAll(async () => {
  work = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "forge-refusals-")));
  await fs.mkdir(path.join(work, "home"));
  // A stand-in for Forge Cloud: the first path segment picks its answer.
  server = http.createServer((req, res) => {
    const [, mode, ...rest] = (req.url ?? "").split("/");
    const route = `/${rest.join("/")}`;
    res.setHeader("Content-Type", "application/json");
    if (route === "/api/cli/device") {
      res.end(
        JSON.stringify({
          deviceCode: "dc",
          userCode: "ABCD-EFGH",
          verificationUri: "http://verify.example",
          expiresIn: 5,
          interval: 0,
        }),
      );
      return;
    }
    if (route === "/api/cli/token") {
      res.end(JSON.stringify(mode === "unknown" ? { status: "weird" } : { status: mode }));
      return;
    }
    res.statusCode = 403;
    res.end(JSON.stringify({ error: `refused by the test server (${req.method} ${route})` }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  fixtures.empty = path.join(work, "empty");
  await fs.mkdir(fixtures.empty);
  await run(work, ["init", "rec"], {});
  fixtures.rec = path.join(work, "rec");
  git(fixtures.rec, "add", "-A");
  git(fixtures.rec, "commit", "-qm", "seed");
  fixtures.noId = await frozen("no-id", {});
  fixtures.noBuild = await frozen("no-build", { projectId: "p-1" });
  fixtures.full = await frozen("full", {
    projectId: "p-1",
    build: { command: "true", output: "dist" },
  });
  signedInDir = await signedInHome();
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(work, { recursive: true, force: true });
});

const CASES: Array<
  [string, () => string, () => string[], number, string, () => Record<string, string>]
> = [
  [
    "publish: no freeze",
    () => fixtures.rec,
    () => ["publish", "nope"],
    1,
    'forge publish: no freeze tagged "nope" — run `forge freeze nope` first.\n',
    () => ({}),
  ],
  [
    "publish: no projectId",
    () => fixtures.noId,
    () => ["publish", "v1"],
    1,
    "forge publish: this repo has no projectId in forge.json — freeze once first.\n",
    () => ({}),
  ],
  [
    "publish: no build",
    () => fixtures.noBuild,
    () => ["publish", "v1"],
    1,
    'forge publish: forge.json declares no "build" — there is nothing to host.\nDeclare how this project builds, then freeze and publish again:\n  "build": { "command": "npm run build", "output": "dist" }\n',
    () => ({}),
  ],
  [
    "publish: not signed in",
    () => fixtures.full,
    () => ["publish", "v1"],
    1,
    "\nforge publish: this needs Forge Cloud, which is in closed beta for invited accounts — run `forge login` if you have one\n",
    () => ({}),
  ],
  [
    "publish: service refuses",
    () => fixtures.full,
    () => ["publish", "v1"],
    1,
    "\nforge publish: refused by the test server (POST /api/cli/publish)\n",
    () => ({ FORGE_HOME: signedIn() }),
  ],
  [
    "unpublish: no projectId",
    () => fixtures.noId,
    () => ["unpublish", "v1"],
    1,
    "forge unpublish: this repo has no projectId in forge.json — nothing was published from here.\n",
    () => ({}),
  ],
  [
    "unpublish: service refuses",
    () => fixtures.full,
    () => ["unpublish", "v1"],
    1,
    "forge unpublish: refused by the test server (POST /api/cli/withdraw)\n",
    () => ({ FORGE_HOME: signedIn() }),
  ],
  [
    "login: unreachable",
    () => fixtures.rec,
    () => ["login", "--url", "http://127.0.0.1:1"],
    1,
    "forge login: fetch failed\n",
    () => ({}),
  ],
  [
    "login: denied",
    () => fixtures.rec,
    () => ["login", "--url", `${base}/denied`],
    1,
    "\nforge login: the request was denied in the browser. Nothing was stored.\n",
    () => ({}),
  ],
  [
    "login: expired",
    () => fixtures.rec,
    () => ["login", "--url", `${base}/expired`],
    1,
    "\nforge login: that code expired before it was approved. Try again.\n",
    () => ({}),
  ],
  [
    "login: unknown",
    () => fixtures.rec,
    () => ["login", "--url", `${base}/unknown`],
    1,
    "\nforge login: Forge Cloud did not recognise this sign-in. Try again.\n",
    () => ({}),
  ],
  [
    "upgrade: unknown target",
    () => fixtures.rec,
    () => ["upgrade", "--to", "0.3"],
    1,
    'forge upgrade: unknown target version "0.3" (expected 0.1 or 0.2)\n',
    () => ({}),
  ],
  [
    "index: not a record",
    () => fixtures.empty,
    () => ["index"],
    1,
    "forge index: forge.json not found — not a Forge record (run `forge init`)\n",
    () => ({}),
  ],
  [
    "adopt: bad limit",
    () => fixtures.rec,
    () => ["adopt", "--limit", "0"],
    1,
    'forge adopt: --limit must be a positive number — got "0"\n',
    () => ({}),
  ],
  [
    "adopt: not a repo",
    () => fixtures.empty,
    () => ["adopt"],
    1,
    "forge adopt: not inside a Git repository\n",
    () => ({}),
  ],
  [
    "skills install: --source without --home",
    () => fixtures.rec,
    () => ["skills", "install", "--source", "x"],
    1,
    "forge skills install: --source only applies with --home\n",
    () => ({}),
  ],
  [
    "skills install: --home --agents",
    () => fixtures.rec,
    () => ["skills", "install", "--home", "--agents"],
    1,
    "forge skills install: --agents writes a project's AGENTS.md — run it without --home\n",
    () => ({}),
  ],
  [
    "skills install: --home bad source",
    () => fixtures.rec,
    () => ["skills", "install", "--home", "--source", path.join(work, "no-such-checkout")],
    1,
    "forge skills install: <work>/no-such-checkout has no forge-ddr/SKILL.md — point --source at a Forge checkout's skills/\n",
    () => ({}),
  ],
  [
    "skills show: unknown",
    () => fixtures.rec,
    () => ["skills", "show", "nope"],
    1,
    'forge skills show: no skill "nope" — available: forge-ddr, forge-freeze, forge-init, forge-intake, forge-review, forge-triage, agents\n',
    () => ({}),
  ],
  [
    "changelog apply: no such batch",
    () => fixtures.rec,
    () => ["changelog", "apply", "nope"],
    1,
    "forge changelog apply: no staged changelog at .forge/changelog/nope.json — run `forge changelog draft` first\n",
    () => ({}),
  ],
  [
    "changelog apply: not a batch name",
    () => fixtures.rec,
    () => ["changelog", "apply", "../escape"],
    1,
    'forge changelog apply: "../escape" is not a batch name — use the name `forge changelog draft` printed\n',
    () => ({}),
  ],
  [
    "add: unknown concept",
    () => fixtures.rec,
    () => ["add", "nonsense"],
    1,
    'forge add: "nonsense" is not a concept in this format — run `forge add` to see the whole set\n  the set is: brief, todos, feature-log, check, decision, question, feedback, change, term, story, role, stakeholder, flow, scenario, calendar, data-model, design-system, components, pages\n',
    () => ({}),
  ],
  [
    "add: known concept, exists",
    () => fixtures.rec,
    () => ["add", "brief"],
    1,
    "forge add: a Brief is written by `forge init`, not by `forge add`\n",
    () => ({}),
  ],
  [
    "question: bad status",
    () => fixtures.rec,
    () => ["question", "Why?", "--status", "bogus"],
    1,
    'forge question: status must be one of open, resolved, dropped — got "bogus"\n',
    () => ({}),
  ],
  [
    "task add: no ledger",
    () => fixtures.empty,
    () => ["task", "add", "Do it"],
    1,
    "forge task add: no task ledger found — run `forge init` (or `forge upgrade`) first.\n",
    () => ({}),
  ],
  [
    "dash: no dashboard",
    () => fixtures.rec,
    () => ["dash"],
    1,
    "forge dash: the local dashboard runs from a Forge source checkout and is not part of the\n  npm package. Set FORGE_DASHBOARD_DIR to the dashboard package in a checkout.\n",
    () => ({ FORGE_DASHBOARD_DIR: path.join(work, "no-dashboard") }),
  ],
  [
    "doctor: not a record (result, unchanged)",
    () => fixtures.empty,
    () => ["doctor"],
    2,
    "",
    () => ({}),
  ],
  [
    "freeze: domain error via the bin's catch",
    () => fixtures.empty,
    () => ["freeze", "v9", "-m", "x"],
    1,
    "not inside a Git repository\n",
    () => ({}),
  ],
];

describe("what each command says when it refuses (TASK-541)", () => {
  it.each(CASES)("%s", async (_name, cwd, args, status, stderr, env) => {
    const result = await run(cwd(), args(), env());
    expect(result.stderr).toBe(stderr);
    expect(result.status).toBe(status);
  });
});
