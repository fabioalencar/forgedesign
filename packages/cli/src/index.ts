#!/usr/bin/env node
import { Command } from "commander";
import { registerCommentsCommand } from "./commands/comments.js";
import { registerDashCommand } from "./commands/dash.js";
import { registerDdrCommand } from "./commands/ddr.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerExploreCommand } from "./commands/explore.js";
import { registerFreezeCommand } from "./commands/freeze.js";
import { registerIndexCommand } from "./commands/index-command.js";
import { registerInitCommand } from "./commands/init.js";
import { registerIntakeCommand } from "./commands/intake.js";
import { registerCloudAuthCommands } from "./commands/login.js";
import { registerPreviewCommand } from "./commands/preview.js";
import { registerPublishCommand } from "./commands/publish.js";
import { registerQuestionCommand, registerTaskCommand } from "./commands/question.js";
import { registerSkillsCommand } from "./commands/skills.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerUpgradeCommand } from "./commands/upgrade.js";

const program = new Command();

program
  .name("forge")
  .description(
    "The design record: versioning ceremony and stakeholder feedback for AI-built prototypes",
  )
  .version("0.1.0");

registerInitCommand(program);
registerDoctorCommand(program);
registerIndexCommand(program);
registerUpgradeCommand(program);
registerCloudAuthCommands(program);
registerPublishCommand(program);
registerSkillsCommand(program);
registerDdrCommand(program);
registerQuestionCommand(program);
registerTaskCommand(program);
registerIntakeCommand(program);
registerStatusCommand(program);
registerFreezeCommand(program);
registerCommentsCommand(program);
registerDashCommand(program);
registerExploreCommand(program);
registerPreviewCommand(program);

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
