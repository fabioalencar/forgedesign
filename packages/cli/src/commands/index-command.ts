import type { Command } from "commander";
import { writeBundleIndex } from "../bundle-index.js";

export function registerIndexCommand(program: Command): void {
  program
    .command("index")
    .argument("[path]", "record root (defaults to the current directory)")
    .description("regenerate the bundle's index.md from the concepts on disk")
    .action(async (targetPath: string | undefined) => {
      const result = await writeBundleIndex(targetPath ?? process.cwd());
      if (result.path === null) {
        console.log("forge index: nothing to do — this record has no v0.2 bundle");
        return;
      }
      console.log(
        result.changed
          ? `forge index: rewrote ${result.path} (${result.conceptCount} concept(s))`
          : `forge index: ${result.path} is already current`,
      );
    });
}
