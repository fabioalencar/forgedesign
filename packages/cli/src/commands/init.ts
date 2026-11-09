import type { Command } from "commander";
import { initProject } from "../init.js";
import { registryPath } from "../registry.js";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .argument("[name]", "directory to create (defaults to the current directory)")
    .description(
      "create the Design Record's core files (design/index.md, brief.md, todos.md, decisions/, forge.json) and register the project; existing files are never overwritten",
    )
    .action(async (name: string | undefined) => {
      const result = await initProject(name ?? process.cwd());

      console.log(`Initialized the Design Record for "${result.name}" at ${result.root}`);
      if (result.written.length > 0) {
        console.log(`  created: ${result.written.join(", ")}`);
      }
      if (result.skipped.length > 0) {
        console.log(`  kept existing: ${result.skipped.join(", ")}`);
      }
      for (const { target, variant } of result.blocked) {
        console.warn(
          `  warning: could not create ${target} — ${variant} differs from it only by case, ` +
            `and on this filesystem they are the same path. Rename ${variant}, then rerun.`,
        );
      }
      if (result.gitInitialized) console.log("  initialized Git repository");
      if (result.gitIgnoreUpdated) console.log("  added .forge/ to .gitignore");
      if (result.gitWarning) console.warn(`  warning: ${result.gitWarning}`);
      console.log(`  registered in ${registryPath()}`);
      console.log("\nNext steps:");
      if (name) console.log(`  cd ${name}`);
      console.log("  fill in design/brief.md — everything else grows from it");
      console.log("  forge doctor");
    });
}
