import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CAPTURE_VIEWPORT,
  type CaptureBrowser,
  type CapturePage,
  capturePath,
  captureRoutes,
  collectCaptures,
  describeCaptures,
  ENABLE_CAPTURES,
  playwrightLauncher,
  serveBuild,
} from "../src/capture.js";

let buildDir: string;

beforeEach(async () => {
  buildDir = await fs.mkdtemp(path.join(tmpdir(), "forge-capture-"));
  await write("index.html", "<h1>home</h1>");
  await write("sign-in/index.html", "<h1>sign in</h1>");
  await write("assets/app.css", "body{}");
});

afterEach(async () => {
  await fs.rm(buildDir, { recursive: true, force: true });
});

async function write(relPath: string, text: string): Promise<void> {
  const file = path.join(buildDir, relPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, "utf8");
}

/**
 * A browser that loads each page over real HTTP from `serveBuild` and
 * "screenshots" it as the URL it visited, so a test can see what was asked
 * for without Chromium.
 */
function fakeBrowser(options: { throwOn?: string } = {}) {
  const contexts: Array<{ viewport: unknown; deviceScaleFactor: number }> = [];
  let closed = false;
  const browser: CaptureBrowser = {
    async newContext(contextOptions) {
      contexts.push(contextOptions);
      return {
        async newPage(): Promise<CapturePage> {
          let visited = "";
          return {
            async goto(url) {
              visited = url;
              if (options.throwOn && url.includes(options.throwOn))
                throw new Error("net::ERR_ABORTED\nstack");
              const res = await fetch(url);
              return { status: () => res.status };
            },
            async waitForLoadState() {},
            async evaluate<T>() {
              return undefined as T;
            },
            async waitForTimeout() {},
            async screenshot(screenshotOptions) {
              expect(screenshotOptions).toEqual({
                type: "jpeg",
                quality: 80,
                animations: "disabled",
              });
              return Buffer.from(visited);
            },
            async close() {},
          };
        },
        async close() {},
      };
    },
    async close() {
      closed = true;
    },
  };
  return { browser, contexts, isClosed: () => closed };
}

const decoded = (content: string) =>
  new URL(Buffer.from(content, "base64").toString("utf8")).pathname;

describe("serveBuild", () => {
  it("serves a directory route at its trailing slash, assets with their type, and nothing outside", async () => {
    const server = await serveBuild(buildDir);
    try {
      const page = await fetch(`${server.origin}/sign-in/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toBe("<h1>sign in</h1>");
      expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const css = await fetch(`${server.origin}/assets/app.css`);
      expect(css.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect((await fetch(`${server.origin}/missing/`)).status).toBe(404);
      // A dot segment is resolved by the URL parser before it arrives, so it lands inside.
      expect((await fetch(`${server.origin}/%2e%2e/%2e%2e/etc/passwd`)).status).toBe(404);
      // An encoded slash is not, and it is the server's own check that refuses it.
      expect((await fetch(`${server.origin}/..%2f..%2fetc%2fpasswd`)).status).toBe(403);
    } finally {
      await server.close();
    }
  });
});

describe("captureRoutes (DDR-177)", () => {
  it("renders every route at one desktop viewport, at its trailing slash, as JPEG files named by route", async () => {
    const fake = fakeBrowser();
    const seen: string[] = [];
    const result = await captureRoutes({
      buildDir,
      routes: ["/", "/sign-in"],
      launch: async () => fake.browser,
      onRoute: (route) => seen.push(route),
    });

    expect(fake.contexts).toEqual([{ viewport: CAPTURE_VIEWPORT, deviceScaleFactor: 1 }]);
    expect(seen).toEqual(["/", "/sign-in"]);
    expect(
      result.files.map((file) => [file.path, file.contentType, decoded(file.content)]),
    ).toEqual([
      ["index.jpg", "image/jpeg", "/"],
      ["sign-in/index.jpg", "image/jpeg", "/sign-in/"],
    ]);
    expect(result).toMatchObject({ total: 2, failed: [], skipped: [] });
    expect(fake.isClosed()).toBe(true);
  });

  it("leaves out a route that answers an error or throws, names it, and captures the rest", async () => {
    const fake = fakeBrowser({ throwOn: "/sign-in/" });
    const result = await captureRoutes({
      buildDir,
      routes: ["/", "/gone", "/sign-in"],
      launch: async () => fake.browser,
    });
    expect(result.files.map((file) => file.path)).toEqual(["index.jpg"]);
    expect(result.failed).toEqual([
      { route: "/gone", reason: "the page answered 404" },
      { route: "/sign-in", reason: "net::ERR_ABORTED" },
    ]);
  });

  it("captures at most the limit, and says which routes it skipped", async () => {
    const result = await captureRoutes({
      buildDir,
      routes: ["/", "/sign-in", "/sign-in/"],
      launch: async () => fakeBrowser().browser,
      limit: 1,
    });
    expect(result.files.map((file) => file.path)).toEqual(["index.jpg"]);
    expect(result).toMatchObject({ total: 2, skipped: ["/sign-in"] });
  });

  it("is unavailable, not failed, when the browser will not start", async () => {
    const result = await captureRoutes({
      buildDir,
      routes: ["/"],
      launch: async () => {
        throw new Error("Executable doesn't exist at /ms-playwright/chromium\nmore");
      },
    });
    expect(result.files).toEqual([]);
    expect(result.unavailable).toBe(
      `Chromium did not start (Executable doesn't exist at /ms-playwright/chromium) — ${ENABLE_CAPTURES}`,
    );
  });
});

describe("collectCaptures", () => {
  it("reads the routes from the build, as freeze hashes them", async () => {
    const result = await collectCaptures(buildDir, { launch: async () => fakeBrowser().browser });
    expect(result.files.map((file) => file.path)).toEqual(["index.jpg", "sign-in/index.jpg"]);
  });

  const playwrightInstalled = (() => {
    try {
      createRequire(import.meta.url).resolve("playwright");
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(playwrightInstalled)(
    "says how to turn captures on when Playwright is not installed",
    async () => {
      expect(await playwrightLauncher()).toEqual({
        unavailable: `Playwright is not installed — ${ENABLE_CAPTURES}`,
      });
      const result = await collectCaptures(buildDir);
      expect(result).toMatchObject({ files: [], total: 2 });
      expect(describeCaptures(result, undefined)).toEqual([
        `no route captures — Playwright is not installed — ${ENABLE_CAPTURES}`,
      ]);
    },
  );
});

describe("playwrightLauncher", () => {
  it("finds Playwright installed in the project, where a globally installed CLI would not look", async () => {
    const project = await fs.mkdtemp(path.join(tmpdir(), "forge-capture-project-"));
    try {
      await fs.writeFile(path.join(project, "package.json"), "{}");
      const pkg = path.join(project, "node_modules", "playwright");
      await fs.mkdir(pkg, { recursive: true });
      await fs.writeFile(
        path.join(pkg, "package.json"),
        JSON.stringify({ name: "playwright", main: "index.js" }),
      );
      await fs.writeFile(
        path.join(pkg, "index.js"),
        "module.exports = { chromium: { launch: async () => ({ fromProject: true }) } };\n",
      );

      const launch = await playwrightLauncher(project);
      expect(typeof launch).toBe("function");
      expect(await (launch as () => Promise<unknown>)()).toEqual({ fromProject: true });
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });
});

describe("describeCaptures", () => {
  const file = { path: "index.jpg", content: "", contentType: "image/jpeg" };

  it("says how many Cloud stored, which routes did not render, and how many were past the limit", () => {
    expect(
      describeCaptures(
        {
          files: [file],
          total: 103,
          failed: [{ route: "/gone", reason: "the page answered 404" }],
          skipped: ["/z1", "/z2"],
        },
        1,
      ),
    ).toEqual([
      "1 route capture(s) stored for the changelog",
      "  not captured: `/gone` — the page answered 404",
      "  2 route(s) past the first 100 were not captured, from `/z1`",
    ]);
  });

  it("says how many of the captures Cloud stored when some did not upload", () => {
    expect(describeCaptures({ files: [file, file], total: 2, failed: [], skipped: [] }, 1)).toEqual(
      ["1 of 2 route capture(s) stored for the changelog — the rest did not upload"],
    );
  });

  it("says plainly when Cloud predates captures", () => {
    expect(
      describeCaptures({ files: [file], total: 1, failed: [], skipped: [] }, undefined),
    ).toEqual([
      "route captures were not stored — this Cloud predates them; the build is hosted as before",
    ]);
  });
});

describe("capturePath", () => {
  it("names a capture by its route, the way the build names its page", () => {
    expect(capturePath("/")).toBe("index.jpg");
    expect(capturePath("/sign-in/")).toBe("sign-in/index.jpg");
    expect(capturePath("/a/b")).toBe("a/b/index.jpg");
  });
});
