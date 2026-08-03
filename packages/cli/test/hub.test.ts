import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FreezeRecord } from "../src/freezes.js";
import { generateReleaseHub } from "../src/hub.js";

let sandbox: string;

const freeze = (tag: string): FreezeRecord => ({
  tag,
  date: tag === "alpha" ? "2026-07-11" : "2026-07-12",
  commit: `${tag}-commit`,
  previewUrl: `https://preview.example/${tag}`,
  storybookUrl: `https://storybook.example/${tag}`,
  pin: "123456",
  snapshotId: null,
});

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-hub-"));
  // The hub links the bundle's documents and nothing older (DDR-095), so the
  // fixture is a current record rather than the v1 `context/` layout it used to
  // be — that layout's document list left with the format.
  await fs.mkdir(path.join(sandbox, "design"), { recursive: true });
  await fs.writeFile(
    path.join(sandbox, "forge.json"),
    JSON.stringify({ formatVersion: "0.2", recordRoot: "design" }, null, 2),
    "utf8",
  );
  await fs.writeFile(
    path.join(sandbox, "design", "brief.md"),
    "---\ntype: Brief\ntitle: Brief\n---\nA useful project.\n",
    "utf8",
  );
  await fs.mkdir(path.join(sandbox, "context"), { recursive: true });
  await fs.mkdir(path.join(sandbox, "artifacts", "user-flows"), { recursive: true });
  await fs.writeFile(path.join(sandbox, "context", "brief.md"), "# A useful project\n", "utf8");
  await fs.writeFile(
    path.join(sandbox, "artifacts", "user-flows", "checkout.md"),
    "---\nstatus: in-review\n---\n# Checkout flow\n",
    "utf8",
  );
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe("generateReleaseHub", () => {
  it("creates a first-freeze hub with versions, artifact states, and honest empty types", async () => {
    const result = await generateReleaseHub(sandbox, [freeze("alpha")]);
    const page = await fs.readFile(path.join(sandbox, "hub", "index.html"), "utf8");

    expect(result?.indexPath).toBe(path.join(sandbox, "hub", "index.html"));
    expect(page).toContain("Forge · release hub");
    expect(page).toContain("alpha");
    expect(page).toContain("https://preview.example/alpha");
    expect(page).toContain("in-review");
    expect(page).toContain("No journey maps yet.");
    expect(page).toContain("Project brief");
    await expect(fs.access(path.join(sandbox, "hub", "styles.css"))).resolves.toBeUndefined();
  });

  it("replaces the hub and lists later freezes newest first", async () => {
    await generateReleaseHub(sandbox, [freeze("alpha")]);
    await generateReleaseHub(sandbox, [freeze("alpha"), freeze("beta")]);
    const page = await fs.readFile(path.join(sandbox, "hub", "index.html"), "utf8");

    expect(page.indexOf(">beta<")).toBeLessThan(page.indexOf(">alpha<"));
    expect((await fs.readdir(path.join(sandbox, "hub"))).sort()).toEqual([
      "index.html",
      "styles.css",
    ]);
  });

  it("does not create a hub before a project has a freeze", async () => {
    await expect(generateReleaseHub(sandbox, [])).resolves.toBeNull();
    await expect(fs.access(path.join(sandbox, "hub", "index.html"))).rejects.toThrow();
  });
});
