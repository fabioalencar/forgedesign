import { describe, expect, it } from "vitest";
import { splitCommand } from "../src/commands/preview.js";

describe("splitCommand (T-113)", () => {
  it("splits a plain command on whitespace", () => {
    expect(splitCommand("pnpm dev -- --port {port}")).toEqual([
      "pnpm",
      "dev",
      "--",
      "--port",
      "{port}",
    ]);
  });

  it("keeps a double-quoted argument intact", () => {
    expect(splitCommand('npm run dev --name "my app"')).toEqual([
      "npm",
      "run",
      "dev",
      "--name",
      "my app",
    ]);
  });

  it("keeps a single-quoted argument intact", () => {
    expect(splitCommand("node -e 'process.exit(0)'")).toEqual(["node", "-e", "process.exit(0)"]);
  });

  it("collapses irregular whitespace", () => {
    expect(splitCommand("  pnpm   dev  ")).toEqual(["pnpm", "dev"]);
  });
});
