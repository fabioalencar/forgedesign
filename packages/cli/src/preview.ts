// Live preview runner (DDR-020, amended by DDR-053): give the current branch's
// HEAD its own detached git worktree under .forge/preview/<slug> and run the
// prototype's dev server there, on an ephemeral port. The main checkout is
// never touched — which is also why the preview shows the last commit rather
// than the working tree (git refuses a second worktree on a checked-out
// branch, so the worktree is detached at the same commit).
// Consent lives with the caller (CLI prints / dashboard gates the exact
// command before launch); this module only ever runs the command it was given.

import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { checkedOutBranch, git, requireRepoRoot } from "./git.js";
import { readProjectFile } from "./project.js";

/** Default dev command; `{port}` is replaced with the allocated port. */
export const DEFAULT_PREVIEW_COMMAND = [
  "pnpm",
  "dev",
  "--",
  "--host",
  "127.0.0.1",
  "--port",
  "{port}",
];
export const DEFAULT_PREVIEW_INSTALL = ["pnpm", "install"];
/** Directory inside the worktree the command runs in (repo convention). */
export const DEFAULT_PREVIEW_DIR = "prototype";
export const PREVIEW_BRIDGE_CONFIG_ENV = "FORGE_PREVIEW_BRIDGE_CONFIG";

/** Public, ephemeral routing data passed only to a Forge-launched dev server. */
export interface PreviewBridgeLaunch {
  protocolVersion: 1;
  dashboardOrigin: string;
  projectId: string;
  exploration: string;
  sessionId: string;
  nonce: string;
}

export interface PreviewBridgeConfig extends PreviewBridgeLaunch {
  previewOrigin: string;
}

function isExactOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function validBridgeLaunch(bridge: PreviewBridgeLaunch): boolean {
  return (
    bridge.protocolVersion === 1 &&
    isExactOrigin(bridge.dashboardOrigin) &&
    bridge.projectId.length > 0 &&
    bridge.projectId.length <= 200 &&
    bridge.exploration.length > 0 &&
    bridge.exploration.length <= 200 &&
    bridge.sessionId.length > 0 &&
    bridge.sessionId.length <= 200 &&
    /^[a-f0-9]{32}$/i.test(bridge.nonce)
  );
}

export interface PreviewRecord {
  name: string;
  branch: string;
  /** absolute worktree path (.forge/preview/<name>) */
  worktree: string;
  /** directory (relative to the worktree) the command runs in */
  dir: string;
  /** the exact command line launched — surfaced for the consent gate */
  command: string;
  port: number;
  url: string;
  pid: number;
  startedAt: string;
  /** Present only for an explicit, Forge-launched development adapter. */
  bridge?: PreviewBridgeConfig;
  /** Adapter expected to produce the bridge handshake for this preview. */
  bridgeAdapter?: "react-vite";
}

export interface PreviewStatus extends PreviewRecord {
  running: boolean;
}

/**
 * Branch name → a filesystem-safe preview identity. Branches can carry
 * slashes and other characters a directory name cannot, and this becomes both
 * `.forge/preview/<slug>/` and the record's key.
 */
export function previewSlug(branch: string): string {
  return (
    branch
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "preview"
  );
}

function previewDir(root: string): string {
  return path.join(root, ".forge", "preview");
}

function metaPath(root: string, name: string): string {
  return path.join(previewDir(root), `${name}.json`);
}

function logPath(root: string, name: string): string {
  return path.join(previewDir(root), `${name}.log`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Is something accepting TCP connections on the port right now? */
async function portListening(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const settle = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

async function readMeta(root: string, name: string): Promise<PreviewRecord | null> {
  try {
    return JSON.parse(await fs.readFile(metaPath(root, name), "utf8")) as PreviewRecord;
  } catch {
    return null;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

/** Polls until something accepts TCP connections on the port, or times out. */
async function waitForPort(
  port: number,
  timeoutMs: number,
  stillAlive: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!stillAlive()) throw new Error("dev server exited before becoming ready");
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (connected) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`dev server did not accept connections on :${port} within ${timeoutMs}ms`);
}

export interface StartPreviewOptions {
  cwd?: string;
  /** dev command tokens; "{port}" is replaced (default DEFAULT_PREVIEW_COMMAND) */
  command?: string[];
  /** directory inside the worktree to run in (default "prototype") */
  dir?: string;
  /** install command for a newly-created worktree; false skips it */
  install?: string[] | false;
  /** how long to wait for the port to accept connections (default 30s) */
  readyTimeoutMs?: number;
  log?: (line: string) => void;
  /** Never logged or persisted outside the local preview record. */
  bridge?: PreviewBridgeLaunch;
  bridgeAdapter?: "react-vite";
}

/** Split a config/CLI command without a shell, preserving quoted arguments. */
export function splitCommand(command: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let match = re.exec(command); match !== null; match = re.exec(command)) {
    args.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return args;
}

export async function previewConfig(repoRoot: string) {
  return (await readProjectFile(repoRoot)).preview;
}

async function runInstall(
  tokens: string[],
  cwd: string,
  log: (line: string) => void,
): Promise<void> {
  if (tokens.length === 0) throw new Error("preview install command is empty");
  log(`Installing preview dependencies: ${tokens.join(" ")} (in ${cwd})…`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(tokens[0]!, tokens.slice(1), {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => log(String(chunk).trimEnd()));
    child.stderr?.on("data", (chunk) => log(String(chunk).trimEnd()));
    child.once("error", (error) =>
      reject(new Error(`could not install preview dependencies: ${error.message}`)),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`preview install exited with ${code ?? "unknown"}`)),
    );
  });
}

/**
 * Starts (or reuses) the live preview for the current branch (DDR-053).
 * Returns the running record; a still-alive previous server for the same
 * branch is reused as-is.
 */
export async function startPreview(options: StartPreviewOptions = {}): Promise<PreviewRecord> {
  const log = options.log ?? (() => {});

  const root = await requireRepoRoot(options.cwd);
  if (options.bridge && (!validBridgeLaunch(options.bridge) || !options.bridgeAdapter)) {
    throw new Error("invalid Preview Bridge launch configuration");
  }
  const branch = await checkedOutBranch(root);
  if (!branch) {
    throw new Error("cannot preview a detached HEAD — check out a branch first");
  }
  const name = previewSlug(branch);

  // Reuse a live server; clean up a stale record.
  const existing = await readMeta(root, name);
  if (existing) {
    if (pidAlive(existing.pid)) {
      log(`Preview already running at ${existing.url} (pid ${existing.pid}).`);
      return existing;
    }
    await fs.rm(metaPath(root, name), { force: true });
  }

  const config = await previewConfig(root);
  const worktree = path.join(previewDir(root), name);
  const hasWorktree = await fs
    .access(worktree)
    .then(() => true)
    .catch(() => false);
  const createdWorktree = !hasWorktree;
  if (createdWorktree) {
    log(`Creating worktree at ${branch}'s current commit…`);
    await fs.mkdir(previewDir(root), { recursive: true });
    // Detached: git refuses a second worktree on a checked-out branch, so the
    // preview pins the commit rather than sharing the ref (DDR-053).
    await git(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
  }

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const bridge = options.bridge
    ? { ...options.bridge, exploration: name, previewOrigin: url }
    : undefined;
  const dir = options.dir ?? config?.dir ?? DEFAULT_PREVIEW_DIR;
  const tokens = (
    options.command ?? (config?.command ? splitCommand(config.command) : DEFAULT_PREVIEW_COMMAND)
  ).map((t) => t.replaceAll("{port}", String(port)));
  const commandLine = tokens.join(" ");
  const runDir = path.join(worktree, dir);

  if (createdWorktree) {
    const install =
      options.install ??
      (config?.install === false
        ? false
        : config?.install
          ? splitCommand(config.install)
          : DEFAULT_PREVIEW_INSTALL);
    if (install) await runInstall(install, runDir, log);
  }

  log(`Starting dev server: ${commandLine} (in ${runDir})…`);
  const out = createWriteStream(logPath(root, name));
  const child = spawn(tokens[0]!, tokens.slice(1), {
    cwd: runDir,
    env: {
      ...process.env,
      PORT: String(port),
      ...(bridge ? { [PREVIEW_BRIDGE_CONFIG_ENV]: JSON.stringify(bridge) } : {}),
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);

  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const launchError = new Promise<never>((_, reject) => {
    child.once("error", (error) =>
      reject(new Error(`could not launch "${tokens[0]}" — is it installed? (${error.message})`)),
    );
  });

  try {
    await Promise.race([
      waitForPort(port, options.readyTimeoutMs ?? 30_000, () => !exited),
      launchError,
    ]);
  } catch (error) {
    if (!exited && child.pid) killTree(child.pid);
    const tail = await fs
      .readFile(logPath(root, name), "utf8")
      .then((t) => t.split("\n").slice(-8).join("\n"))
      .catch(() => "");
    throw new Error(`${error instanceof Error ? error.message : error}${tail ? `\n${tail}` : ""}`);
  }

  const record: PreviewRecord = {
    name,
    branch,
    worktree,
    dir,
    command: commandLine,
    port,
    url,
    pid: child.pid!,
    startedAt: new Date().toISOString(),
    ...(bridge ? { bridge } : {}),
    ...(bridge ? { bridgeAdapter: options.bridgeAdapter } : {}),
  };
  await fs.writeFile(metaPath(root, name), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  child.unref();
  log(`Preview ready at ${record.url} (pid ${record.pid}).`);
  return record;
}

/** SIGTERM the process group (falls back to the pid), so pnpm's children die too. */
function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

export interface StopPreviewOptions {
  name: string;
  cwd?: string;
  /** also remove the worktree (default false — keep for fast restart) */
  removeWorktree?: boolean;
  log?: (line: string) => void;
}

export async function stopPreview(options: StopPreviewOptions): Promise<{ stopped: boolean }> {
  const log = options.log ?? (() => {});
  const root = await requireRepoRoot(options.cwd);

  const meta = await readMeta(root, options.name);
  let stopped = false;
  if (meta && pidAlive(meta.pid)) {
    killTree(meta.pid);
    // escalate if it ignores SIGTERM
    const deadline = Date.now() + 3000;
    while (pidAlive(meta.pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (pidAlive(meta.pid)) killTree(meta.pid, "SIGKILL");
    stopped = true;
    log(`Stopped preview ${options.name} (pid ${meta.pid}).`);
  }
  await fs.rm(metaPath(root, options.name), { force: true });

  if (options.removeWorktree) {
    const worktree = path.join(previewDir(root), options.name);
    await git(root, ["worktree", "remove", worktree, "--force"]).catch(() => {});
    log(`Removed worktree ${worktree}.`);
  }
  return { stopped };
}

/**
 * All preview records with liveness. Orphaned records (dead pid — e.g. the
 * machine rebooted) are cleaned from disk and reported as not running.
 *
 * A live pid alone is not proof the preview is up: pids get reused, and a
 * wedged dev server still owns one. Since what a caller does with a "running"
 * preview is open its URL, liveness also requires the recorded port to accept
 * a connection. A record whose pid is alive but whose port is silent is
 * reported as not running and deliberately *kept* — it is the only handle
 * `forge preview stop` has on that process.
 */
export async function listPreviews(cwd?: string): Promise<PreviewStatus[]> {
  const root = await requireRepoRoot(cwd);

  let entries: string[] = [];
  try {
    entries = (await fs.readdir(previewDir(root))).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  const statuses: PreviewStatus[] = [];
  for (const entry of entries) {
    const name = entry.slice(0, -".json".length);
    const meta = await readMeta(root, name);
    if (!meta) continue;
    const alive = pidAlive(meta.pid);
    if (!alive) await fs.rm(metaPath(root, name), { force: true });
    statuses.push({ ...meta, running: alive && (await portListening(meta.port)) });
  }
  return statuses;
}
