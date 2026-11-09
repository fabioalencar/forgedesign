// Route captures at publish (DDR-177, TASK-580): one screenshot of every route
// in the build being published, so the changelog can show a stakeholder what a
// screen looked like before and after.
//
// **On the creator's machine, from the build already on disk.** Publish reads
// that directory to upload it; this serves the same directory from loopback and
// renders each route in a local headless Chromium. Nothing here runs in Cloud,
// and nothing here needs the creator's credentials.
//
// **Optional, and never a reason a publish fails.** Playwright is loaded only if
// the creator installed it; without it, or when its browser will not start, the
// publish goes on without captures and says how to add them. A route that will
// not render is left out and named, and one that will not upload is left out by
// publish and by Cloud's commit alike. Captures are the changelog's pictures, and
// the changelog reads complete without them (DDR-138).
//
// The waits copy the ones `pnpm ops backfill-shots` uses (DDR-170: load, a
// network that goes quiet if it ever does, fonts), kept here rather than shared
// because `cloud/` is its own project and depends on no package from this one.

import { promises as fs } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentTypeFor, type PublishFile } from "./publish.js";
import { hashBuiltRoutes, normalizeRoute } from "./routes.js";

/** One desktop viewport at 1×, so a capture stays under DDR-169's 1600 pixels a side. */
export const CAPTURE_VIEWPORT = { width: 1440, height: 900 } as const;
/** At most this many routes per publish; the rest are named, never silently dropped. */
export const CAPTURE_LIMIT = 100;
const LOAD_TIMEOUT_MS = 45_000;
const IDLE_TIMEOUT_MS = 10_000;
const QUIET_MS = 600;
const JPEG_QUALITY = 80;

/** What this module needs of a browser — Playwright's shape, narrowed so a test can stand in. */
export interface CapturePage {
  goto(
    url: string,
    options: { waitUntil: "load"; timeout: number },
  ): Promise<{ status(): number } | null>;
  waitForLoadState(state: "networkidle", options: { timeout: number }): Promise<void>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(options: { type: "jpeg"; quality: number; animations: "disabled" }): Promise<Buffer>;
  close(): Promise<void>;
}

export interface CaptureBrowser {
  newContext(options: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
  }): Promise<{ newPage(): Promise<CapturePage>; close(): Promise<void> }>;
  close(): Promise<void>;
}

export type LaunchBrowser = () => Promise<CaptureBrowser>;

/**
 * Runs in the page: resolves once its web fonts have loaded. Reached through
 * `globalThis` because the CLI compiles without the DOM's types; the cast is
 * erased and the page sees `document.fonts.ready`.
 */
const fontsReady = () =>
  (
    globalThis as unknown as { document: { fonts: { ready: Promise<unknown> } } }
  ).document.fonts.ready.then(() => undefined);

/** What capturing produced, and what it could not, for publish to say. */
export interface CaptureResult {
  /** one JPEG per route captured, declared like build files */
  files: PublishFile[];
  /** routes the build has */
  total: number;
  /** routes that did not render, with why */
  failed: Array<{ route: string; reason: string }>;
  /** routes past the limit */
  skipped: string[];
  /** set when nothing was captured at all, with why — Playwright missing, say */
  unavailable?: string;
}

/** The published path of a route's capture: `index.jpg` for `/`, `sign-in/index.jpg` for `/sign-in`. */
export function capturePath(route: string): string {
  const normal = normalizeRoute(route);
  return normal === "/" ? "index.jpg" : `${normal.slice(1)}/index.jpg`;
}

/** How to turn captures on, in the words publish prints when they are off. */
export const ENABLE_CAPTURES =
  "install Playwright beside forge to send route captures: `npm install -D playwright && npx playwright install chromium`";

type PlaywrightModule = {
  chromium?: { launch(): Promise<CaptureBrowser> };
  default?: { chromium?: { launch(): Promise<CaptureBrowser> } };
};

/**
 * Playwright's Chromium launcher, when the creator installed Playwright, or why
 * not. Looked up beside the project first — where `npm install -D playwright`
 * puts it — and then beside the CLI, since a CLI installed globally resolves
 * bare imports from its own directory and would never see the project's. The
 * name is one the bundler cannot see, so the CLI ships and runs without it.
 */
export async function playwrightLauncher(
  projectRoot?: string,
): Promise<LaunchBrowser | { unavailable: string }> {
  const name = "playwright";
  const candidates: Array<() => Promise<PlaywrightModule>> = [];
  if (projectRoot) {
    candidates.push(async () => {
      const resolved = createRequire(path.join(projectRoot, "package.json")).resolve(name);
      return (await import(pathToFileURL(resolved).href)) as PlaywrightModule;
    });
  }
  candidates.push(async () => (await import(name)) as PlaywrightModule);

  for (const load of candidates) {
    let mod: PlaywrightModule;
    try {
      mod = await load();
    } catch {
      continue;
    }
    // Its CommonJS entry, imported, may carry the launcher on `default` only.
    const chromium = mod.chromium ?? mod.default?.chromium;
    if (!chromium) {
      return { unavailable: `Playwright has no Chromium launcher — ${ENABLE_CAPTURES}` };
    }
    return () => chromium.launch();
  }
  return { unavailable: `Playwright is not installed — ${ENABLE_CAPTURES}` };
}

/**
 * Serves a build directory on loopback the way the review host serves a
 * freeze: a directory route at its trailing slash answers with its
 * `index.html`, and nothing outside the directory is reachable.
 */
export async function serveBuild(
  buildDir: string,
): Promise<{ origin: string; close(): Promise<void> }> {
  const root = path.resolve(buildDir);
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
      const target = path.resolve(root, `.${pathname}`);
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        res.writeHead(403).end();
        return;
      }
      let file = target;
      const stat = await fs.stat(file).catch(() => null);
      if (stat?.isDirectory()) file = path.join(file, "index.html");
      const bytes = await fs.readFile(file).catch(() => null);
      if (bytes === null) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": contentTypeFor(file) }).end(bytes);
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Renders each route at `CAPTURE_VIEWPORT` and returns one JPEG per route that
 * rendered. Never throws: a browser that will not start is `unavailable`, and a
 * route that will not render is `failed`, so publish can go on either way.
 */
export async function captureRoutes(input: {
  buildDir: string;
  routes: readonly string[];
  launch: LaunchBrowser;
  limit?: number;
  /** told before each route, for a progress line */
  onRoute?: (route: string, index: number, count: number) => void;
}): Promise<CaptureResult> {
  const limit = input.limit ?? CAPTURE_LIMIT;
  const routes = [...new Set(input.routes.map(normalizeRoute))];
  const chosen = routes.slice(0, limit);
  const result: CaptureResult = {
    files: [],
    total: routes.length,
    failed: [],
    skipped: routes.slice(limit),
  };
  if (chosen.length === 0) return result;

  let browser: CaptureBrowser;
  try {
    browser = await input.launch();
  } catch (error) {
    const first = error instanceof Error ? error.message.split("\n")[0] : String(error);
    return { ...result, unavailable: `Chromium did not start (${first}) — ${ENABLE_CAPTURES}` };
  }

  const server = await serveBuild(input.buildDir);
  try {
    const context = await browser.newContext({ viewport: CAPTURE_VIEWPORT, deviceScaleFactor: 1 });
    try {
      for (const [index, route] of chosen.entries()) {
        input.onRoute?.(route, index, chosen.length);
        const page = await context.newPage();
        try {
          // At its trailing slash, as the review host serves it, so relative
          // asset URLs resolve inside the route rather than beside it.
          const url = `${server.origin}${route === "/" ? "/" : `${route}/`}`;
          const response = await page.goto(url, { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
          if (!response || response.status() >= 400) {
            result.failed.push({
              route,
              reason: `the page answered ${response?.status() ?? "nothing"}`,
            });
            continue;
          }
          await page.waitForLoadState("networkidle", { timeout: IDLE_TIMEOUT_MS }).catch(() => {});
          await page.evaluate(fontsReady).catch(() => {});
          await page.waitForTimeout(QUIET_MS);
          const bytes = await page.screenshot({
            type: "jpeg",
            quality: JPEG_QUALITY,
            animations: "disabled",
          });
          result.files.push({
            path: capturePath(route),
            content: Buffer.from(bytes).toString("base64"),
            contentType: "image/jpeg",
          });
        } catch (error) {
          const first = error instanceof Error ? error.message.split("\n")[0] : String(error);
          result.failed.push({ route, reason: first ?? "the browser failed" });
        } finally {
          await page.close().catch(() => {});
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }
  return result;
}

/**
 * Every route in the build, captured with the launcher given or Playwright's
 * when it is installed. What publish calls; never throws.
 */
export async function collectCaptures(
  buildDir: string,
  options: {
    /** where to look for the creator's Playwright first */
    projectRoot?: string;
    launch?: LaunchBrowser;
    onRoute?: (route: string, index: number, count: number) => void;
  } = {},
): Promise<CaptureResult> {
  const routes = Object.keys(await hashBuiltRoutes(buildDir));
  const launch = options.launch ?? (await playwrightLauncher(options.projectRoot));
  if (typeof launch !== "function") {
    return {
      files: [],
      total: routes.length,
      failed: [],
      skipped: [],
      unavailable: launch.unavailable,
    };
  }
  return captureRoutes({ buildDir, routes, launch, onRoute: options.onRoute });
}

/**
 * What publish says about captures once Cloud has answered: how many were
 * stored, which routes did not render or were past the limit, or why there
 * were none. `captureCount` is Cloud's number; undefined means a Cloud that
 * predates captures, which said nothing about them.
 */
export function describeCaptures(
  result: CaptureResult,
  captureCount: number | undefined,
): string[] {
  if (result.unavailable) return [`no route captures — ${result.unavailable}`];
  if (result.files.length === 0 && result.total === 0) return [];
  const lines: string[] = [];
  if (result.files.length > 0) {
    lines.push(
      captureCount === undefined
        ? "route captures were not stored — this Cloud predates them; the build is hosted as before"
        : captureCount < result.files.length
          ? `${captureCount} of ${result.files.length} route capture(s) stored for the changelog — the rest did not upload`
          : `${captureCount} route capture(s) stored for the changelog`,
    );
  }
  for (const { route, reason } of result.failed)
    lines.push(`  not captured: \`${route}\` — ${reason}`);
  if (result.skipped.length > 0) {
    lines.push(
      `  ${result.skipped.length} route(s) past the first ${CAPTURE_LIMIT} were not captured, from \`${result.skipped[0]}\``,
    );
  }
  return lines;
}
