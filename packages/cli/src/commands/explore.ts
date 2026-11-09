import path from "node:path";
import type { Command } from "commander";
import { mergeExplore, startExplore } from "../explore.js";

export function registerExploreCommand(program: Command): void {
  const explore = program
    .command("explore")
    .description("speculative work on explore/<name> branches");

  explore
    .command("start", { isDefault: true })
    .argument("<name>", "exploration name (lowercase slug)")
    .option("--sketch", "sketch mode: scaffold sketches/ with a SKETCH.md brief")
    .description("create and switch to explore/<name>")
    .action(async (name: string, opts: { sketch?: boolean }) => {
      const result = await startExplore({ name, sketch: opts.sketch });
      console.log(`On ${result.branch}. Iterate freely — main stays untouched.`);
      if (result.sketchPath) {
        console.log(`Sketch brief: ${path.relative(process.cwd(), result.sketchPath)}`);
      }
      console.log(`Promote later with: forge explore merge ${name}`);
    });

  explore
    .command("merge")
    .argument("<name>", "exploration to promote")
    .option("--no-ddr", "skip writing the draft DDR")
    .description("promote an exploration: merge explore/<name> into main")
    .action(async (name: string, opts: { ddr: boolean }) => {
      const result = await mergeExplore({ name, ddr: opts.ddr });
      console.log(`Merged ${result.branch}.`);
      if (result.ddrPath) {
        console.log(
          `Created ${path.relative(process.cwd(), result.ddrPath)} (draft) — finish it, set decision_status to accepted, and commit.`,
        );
      }
    });
}
