import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FreezeRecord } from "../src/freezes.js";
import { changedRoutes, compareScreens, hashBuiltRoutes, normalizeRoute } from "../src/routes.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(tmpdir(), "forge-routes-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(relPath: string, content: string): Promise<void> {
  const abs = path.join(dir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

const freeze = (tag: string, routes?: Record<string, string>): FreezeRecord => ({
  tag,
  date: "2026-09-12",
  commit: "x",
  previewUrl: null,
  storybookUrl: null,
  snapshotId: null,
  ...(routes ? { routes } : {}),
});

describe("hashBuiltRoutes (TASK-461)", () => {
  it("hashes every index.html by its route, root first, and ignores assets", async () => {
    await write("index.html", "<h1>sign in</h1>");
    await write("register/index.html", "<h1>register</h1>");
    await write("forgot-password/index.html", "<h1>forgot</h1>");
    await write("_astro/app.abc123.js", "console.log(1)");
    await write("register/og.png", "not a screen");

    expect(await hashBuiltRoutes(dir)).toEqual({
      "/": sha("<h1>sign in</h1>"),
      "/forgot-password": sha("<h1>forgot</h1>"),
      "/register": sha("<h1>register</h1>"),
    });
  });

  it("is empty for a build directory that does not exist", async () => {
    expect(await hashBuiltRoutes(path.join(dir, "nope"))).toEqual({});
  });
});

describe("normalizeRoute", () => {
  it("meets a reviewer's route and a build directory in the middle", () => {
    expect(normalizeRoute("/register/")).toBe("/register");
    expect(normalizeRoute("/register?x=1#top")).toBe("/register");
    expect(normalizeRoute("register")).toBe("/register");
    expect(normalizeRoute("/")).toBe("/");
    expect(normalizeRoute("")).toBe("/");
  });
});

describe("compareScreens", () => {
  it("says so when a freeze recorded no hashes", () => {
    expect(compareScreens(freeze("v1"), null)).toEqual({ kind: "unrecorded" });
  });

  it("calls every screen new on the first freeze", () => {
    expect(compareScreens(freeze("v1", { "/": "a", "/register": "b" }), null)).toEqual({
      kind: "first",
      screens: [
        { route: "/", status: "new" },
        { route: "/register", status: "new" },
      ],
    });
  });

  it("does not compare against a freeze that recorded nothing — it names the routes and stops", () => {
    expect(compareScreens(freeze("v2", { "/": "a" }), freeze("v1"))).toEqual({
      kind: "baseline-unrecorded",
      previousTag: "v1",
      routes: ["/"],
    });
  });

  it("reads new, changed, unchanged and removed from two hashed freezes", () => {
    const comparison = compareScreens(
      freeze("v6", { "/": "a2", "/register": "b", "/welcome": "c" }),
      freeze("v5", { "/": "a1", "/register": "b", "/forgot-password": "d" }),
    );
    expect(comparison).toEqual({
      kind: "compared",
      previousTag: "v5",
      screens: [
        { route: "/", status: "changed" },
        { route: "/forgot-password", status: "removed" },
        { route: "/register", status: "unchanged" },
        { route: "/welcome", status: "new" },
      ],
    });
    expect(changedRoutes(comparison).map((s) => `${s.route} ${s.status}`)).toEqual([
      "/ changed",
      "/forgot-password removed",
      "/welcome new",
    ]);
  });
});
