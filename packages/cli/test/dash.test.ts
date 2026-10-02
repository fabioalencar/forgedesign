import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerDashCommand } from "../src/commands/dash.js";

let sandbox: string;
let previous: string | undefined;

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-dash-"));
  previous = process.env.FORGE_DASHBOARD_DIR;
});

afterEach(async () => {
  if (previous === undefined) delete process.env.FORGE_DASHBOARD_DIR;
  else process.env.FORGE_DASHBOARD_DIR = previous;
  await fs.rm(sandbox, { recursive: true, force: true });
});

function helpWith(dashboardDir: string): string {
  process.env.FORGE_DASHBOARD_DIR = dashboardDir;
  const program = new Command("forge");
  registerDashCommand(program);
  return program.helpInformation();
}

describe("forge dash", () => {
  it("is left out of --help where there is no dashboard to start, as in an npm install", () => {
    expect(helpWith(path.join(sandbox, "missing"))).not.toContain("dash");
  });

  it("is listed where a dashboard exists", async () => {
    await fs.writeFile(path.join(sandbox, "package.json"), "{}", "utf8");
    expect(helpWith(sandbox)).toContain("dash");
  });
});
