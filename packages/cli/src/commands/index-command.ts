import type { Command } from "commander";
import { writeBundleIndex } from "../bundle-index.js";
import { readRecordVersion, versionRefusal } from "../record-version.js";

export function registerIndexCommand(program: Command): void {
  program
    .command("index")
    .argument("[path]", "record root (defaults to the current directory)")
    .description("regenerate the bundle's index.md from the concepts on disk")
    .action(async (targetPath: string | undefined) => {
      const root = targetPath ?? process.cwd();

      // Say the true thing when there is nothing to index: a directory with no
      // manifest is "not a Forge record", not "a record without a bundle", and a
      // pre-0.2 record gets `forge upgrade` — the same answers doctor and freeze
      // give, from the same shared source (DDR-095's sharp edge).
      const version = await readRecordVersion(root);
      if (version.kind !== "current") {
        console.error(`forge index: ${versionRefusal(version)}`);
        process.exitCode = 1;
        return;
      }

      const result = await writeBundleIndex(root);
      if (result.path === null) {
        console.log(
          `forge index: forge.json declares format 0.2 but there is no ${version.recordRoot}/ bundle to index`,
        );
        return;
      }
      console.log(
        result.changed
          ? `forge index: rewrote ${result.path} (${result.conceptCount} concept(s))`
          : `forge index: ${result.path} is already current`,
      );
    });
}
