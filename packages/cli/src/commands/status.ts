import type { Command } from "commander";
import { collectStatus, formatStatus } from "../status.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description(
      "show every registered project: current branch, open todos by section, last freeze, unfetched comments",
    )
    .action(async () => {
      console.log(formatStatus(await collectStatus()));
    });
}
