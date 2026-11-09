import type { Command } from "commander";
import { runFreeze } from "../freeze-ceremony.js";

export function registerFreezeCommand(program: Command): void {
  program
    .command("freeze")
    .argument("<tag>", "immutable version name (alpha, beta, mvp, …)")
    .requiredOption("-m, --message <message>", "annotated tag message")
    .option(
      "--require-check",
      "refuse to tag unless every checker has a report for this commit under design/checks/<tag>/ (see `forge check`)",
    )
    .description(
      "freeze the current version: annotated tag, prototype + Storybook builds, and a freezes.json entry committed on main; the build is static, so any host can serve it",
    )
    .action(async (tag: string, opts: { message: string; requireCheck?: boolean }) => {
      const result = await runFreeze({
        tag,
        message: opts.message,
        requireCheck: opts.requireCheck,
        log: console.log,
      });
      for (const warning of result.warnings) console.warn(`warning: ${warning}`);
      console.log(`\nFroze ${result.record.tag} at ${result.record.commit.slice(0, 7)}`);
      console.log(
        `  preview:   ${result.record.previewUrl ?? "not hosted — the build is static, so any host can serve it"}`,
      );
      console.log(`  storybook: ${result.record.storybookUrl ?? "not deployed"}`);
      console.log(`  handoff pack: handoff/${result.record.tag}/`);
      console.log("  release hub: hub/index.html (publish it with your preferred static host)");
      console.log(
        "\nThe tag and freeze commit are local — publish them with: git push --follow-tags",
      );
    });
}
