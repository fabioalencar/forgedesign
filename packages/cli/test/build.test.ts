import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPrototype } from "../src/build.js";

let sandbox: string;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-build-"));
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

/** A build command that writes one file into `dir` — no install, no bundler. */
const emit = (dir: string) =>
  `node -e "const fs=require('fs');fs.mkdirSync('${dir}',{recursive:true});fs.writeFileSync('${dir}/index.html','ok')"`;

async function writeForgeJson(root: string, build: unknown): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "forge.json"),
    `${JSON.stringify({ formatVersion: "0.1", build }, null, 2)}\n`,
    "utf8",
  );
}

describe("buildPrototype — forge.json build block (DDR-052)", () => {
  it("runs the declared command in the declared dir and returns its output", async () => {
    const root = path.join(sandbox, "app");
    await writeForgeJson(root, { dir: "web", command: emit("out"), output: "out" });
    await fs.mkdir(path.join(root, "web"), { recursive: true });

    const builds = await buildPrototype(root);

    expect(builds.prototypeDir).toBe(path.join(root, "web/out"));
    expect(builds.storybookDir).toBeNull();
    await expect(fs.access(path.join(root, "web/out/index.html"))).resolves.toBeUndefined();
  });

  it("builds Storybook too when declared", async () => {
    const root = path.join(sandbox, "app");
    await writeForgeJson(root, {
      command: emit("dist"),
      output: "dist",
      storybook: { command: emit("sb"), output: "sb" },
    });

    const builds = await buildPrototype(root);

    expect(builds.prototypeDir).toBe(path.join(root, "dist"));
    expect(builds.storybookDir).toBe(path.join(root, "sb"));
  });

  it("fails when the command succeeds but the declared output is missing", async () => {
    const root = path.join(sandbox, "app");
    await writeForgeJson(root, { command: emit("dist"), output: "elsewhere" });

    await expect(buildPrototype(root)).rejects.toThrow(/expected output .*elsewhere is missing/);
  });

  it("fails loudly on an incomplete build block instead of guessing", async () => {
    const root = path.join(sandbox, "app");
    await writeForgeJson(root, { command: emit("dist") });
    await expect(buildPrototype(root)).rejects.toThrow(/needs an "output"/);

    await writeForgeJson(root, { output: "dist" });
    await expect(buildPrototype(root)).rejects.toThrow(/needs a "command"/);

    await writeForgeJson(root, {
      command: emit("dist"),
      output: "dist",
      storybook: { output: "sb" },
    });
    await expect(buildPrototype(root)).rejects.toThrow(/build.storybook.*both/);
  });

  it("names the missing directory when build.dir does not exist", async () => {
    const root = path.join(sandbox, "app");
    await writeForgeJson(root, { dir: "web", command: emit("out"), output: "out" });

    await expect(buildPrototype(root)).rejects.toThrow(/"build.dir" points at .*web, which does/);
  });

  it("does not attempt Storybook when the build itself fails", async () => {
    const root = path.join(sandbox, "app");
    await writeForgeJson(root, {
      command: 'node -e "process.exit(1)"',
      output: "dist",
      storybook: { command: emit("sb"), output: "sb" },
    });

    await expect(buildPrototype(root)).rejects.toThrow(/build failed/);
    await expect(fs.access(path.join(root, "sb"))).rejects.toThrow();
  });
});

describe("buildPrototype — prototype/ scaffold fallback", () => {
  async function writeScaffold(root: string, scripts: Record<string, string>): Promise<void> {
    await fs.mkdir(path.join(root, "prototype"), { recursive: true });
    await fs.writeFile(
      path.join(root, "prototype/package.json"),
      JSON.stringify({ name: "p", private: true, scripts }),
      "utf8",
    );
  }

  it("builds prototype/ with the conventional scripts when forge.json has no build block", async () => {
    const root = path.join(sandbox, "legacy");
    await writeScaffold(root, {
      build: emit("dist"),
      "build-storybook": emit("storybook-static"),
    });

    const builds = await buildPrototype(root);

    expect(builds.prototypeDir).toBe(path.join(root, "prototype/dist"));
    expect(builds.storybookDir).toBe(path.join(root, "prototype/storybook-static"));
  });

  it("points at forge.json when there is no prototype/ to fall back to", async () => {
    const root = path.join(sandbox, "bare");
    await fs.mkdir(root, { recursive: true });

    await expect(buildPrototype(root)).rejects.toThrow(/declare a "build" block in forge.json/);
  });
});
