import type { Command } from "commander";
import { applyDdr } from "../ddr.js";

export function registerDdrCommand(program: Command): void {
  const ddr = program
    .command("ddr")
    .description("decisions/ (spec/format.md) — the forge-ddr skill's write path");

  ddr
    .command("apply")
    .argument("<slug>", "lowercase-hyphenated slug matching .forge/ddr/<slug>.json")
    .argument("[path]", "record root (defaults to the current directory)")
    .description(
      "validate a staged decision (.forge/ddr/<slug>.json) and write decisions/DDR-###-<slug>.md with the next allocated id",
    )
    .action(async (slug: string, targetPath: string | undefined) => {
      const result = await applyDdr(targetPath ?? process.cwd(), slug);
      console.log(`forge ddr apply: wrote ${result.path} (${result.id})`);
    });
}
