import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";

/**
 * `forge dash` starts the local dashboard (spec §4). v1 resolves the
 * dashboard package relative to this CLI inside the monorepo (dogfooding
 * form factor, DDR-002); FORGE_DASHBOARD_DIR overrides for other layouts.
 */
function resolveDashboardDir(): string | null {
  const override = process.env.FORGE_DASHBOARD_DIR;
  if (override) return existsSync(path.join(override, "package.json")) ? override : null;
  // dist/index.js → packages/cli → packages/dashboard
  const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const candidate = path.resolve(cliRoot, "../dashboard");
  return existsSync(path.join(candidate, "package.json")) ? candidate : null;
}

export function registerDashCommand(program: Command): void {
  // The dashboard is not published (TASK-406), so an npm install has no
  // dashboard beside it. Listing a command that can only fail is a worse first
  // impression than not listing it: it stays callable, and says why.
  const available = resolveDashboardDir() !== null;
  program
    .command("dash", { hidden: !available })
    .description("start the local Forge dashboard (Next.js) on http://127.0.0.1:4400")
    .action(() => {
      const dir = resolveDashboardDir();
      if (!dir) {
        console.error(
          "forge dash: the local dashboard runs from a Forge source checkout and is not part of the\n" +
            "  npm package. Set FORGE_DASHBOARD_DIR to the dashboard package in a checkout.",
        );
        process.exitCode = 1;
        return;
      }
      console.log(`Starting dashboard from ${dir} …`);
      const child = spawn("pnpm", ["dev"], { cwd: dir, stdio: "inherit" });
      child.on("exit", (code) => {
        process.exitCode = code ?? 0;
      });
    });
}
