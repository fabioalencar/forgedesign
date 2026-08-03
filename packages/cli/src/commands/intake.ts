import { promises as fs } from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { applyIntake, stageIntake } from "../intake.js";

export function registerIntakeCommand(program: Command): void {
  const intake = program.command("intake").description("stage and apply context intake (DDR-021)");

  intake
    .argument("<file>", "local transcript, summary, VTT, SRT, or plain-text source")
    .option("--prompt <prompt>", "optional instruction for the agent session's intake skill")
    .description("stage a context source under .forge/intake for classification (propose-only)")
    .action(async (file: string, options: { prompt?: string }) => {
      const sourcePath = path.resolve(file);
      const source = await fs.readFile(sourcePath, "utf8");
      const staged = await stageIntake({
        sourceName: path.basename(sourcePath),
        source,
        prompt: options.prompt,
      });
      console.log(`Staged ${staged.sourceName} at .forge/intake/${staged.id}.`);
      for (const warning of staged.warnings) console.log(`warning: ${warning.message}`);
      console.log(
        "Classify it with the intake skill in your agent session, then run " +
          `\`forge intake apply ${staged.id}\`${staged.needsConfirmation ? " --confirm" : ""}.`,
      );
    });

  intake
    .command("apply")
    .argument("<id>", "intake id from `forge intake`")
    .option("--confirm", "continue despite the source-quality warnings")
    .description("validate the agent session's proposal.json and stage it for review")
    .action(async (id: string, options: { confirm?: boolean }) => {
      const result = await applyIntake({ id, confirmed: options.confirm, log: console.log });
      console.log(
        `Staged ${result.count} proposal(s) at ${result.staged}. Review and accept items individually.`,
      );
    });
}
