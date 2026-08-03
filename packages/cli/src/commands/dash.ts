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
  program
    .command("dash")
    .description("start the local Forge dashboard (Next.js) on http://127.0.0.1:4400")
    .action(() => {
      const dir = resolveDashboardDir();
      if (!dir) {
        console.error(
          "dashboard package not found — set FORGE_DASHBOARD_DIR to the @forgedesign/dashboard directory",
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
