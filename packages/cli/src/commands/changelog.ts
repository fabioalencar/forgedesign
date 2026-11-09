import type { Command } from "commander";
import { applyChangelog, DISCLOSURE_NOTICE, draftChangelog } from "../changelog.js";
import { CliError, errorMessage } from "../cli-error.js";

/** A refusal names the command it came from, as every other command's does (DDR-157). */
async function as<T>(command: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new CliError(
      `forge changelog ${command}: ${errorMessage(error)}`,
      error instanceof CliError ? error.exitCode : 1,
    );
  }
}

export function registerChangelogCommand(program: Command): void {
  const changelog = program
    .command("changelog")
    .description(
      "changes/ (DDR-176) — what stakeholders are told changed or is coming, applied before each freeze",
    );

  changelog
    .command("draft")
    .argument("[path]", "record root (defaults to the current directory)")
    .description(
      "stage candidate change entries from what closed since the last freeze in .forge/changelog/<batch>.json — nothing is kept until a person sets keep: true",
    )
    .action(async (targetPath: string | undefined) => {
      const result = await as("draft", () => draftChangelog(targetPath ?? process.cwd()));
      const since = result.since === null ? "no freeze yet" : `since ${result.since}`;
      console.log(
        `forge changelog draft: staged ${result.entries.length} candidate(s) in ${result.path} (${since})`,
      );
      for (const entry of result.entries) {
        const what =
          entry.action === "update"
            ? `${entry.id} → ${entry.change_status}`
            : `${entry.change_status.padEnd(9)} ${entry.title ?? ""}`;
        const extras = [
          entry.routes?.length ? `routes ${entry.routes.join(", ")}` : null,
          entry.requested_by ? `requested by ${entry.requested_by}` : null,
          entry.links?.length ? `${entry.links.length} link(s)` : null,
        ].filter((part) => part !== null);
        console.log(
          `  ${entry.action.padEnd(6)} ${what}${extras.length ? ` — ${extras.join(" — ")}` : ""}`,
        );
      }
      console.log(
        `\nNothing is kept yet. Set "keep": true on the entries with UI/UX impact, reword their title and body for the person reading them, add any coming entry by hand, then run \`forge changelog apply ${result.batch}\` before \`forge freeze\`.`,
      );
      console.log(DISCLOSURE_NOTICE);
    });

  changelog
    .command("apply")
    .argument("<batch>", "the batch name `forge changelog draft` printed, e.g. 2026-11-08")
    .argument("[path]", "record root (defaults to the current directory)")
    .description(
      "write the entries kept in .forge/changelog/<batch>.json to changes/CHANGE-###.md — nothing else",
    )
    .action(async (batch: string, targetPath: string | undefined) => {
      const result = await as("apply", () => applyChangelog(targetPath ?? process.cwd(), batch));
      if (result.written.length === 0) {
        console.log(
          `forge changelog apply: nothing kept in ${batch}, nothing written (${result.skipped} candidate(s) left as they were)`,
        );
        return;
      }
      console.log(
        `forge changelog apply: wrote ${result.written.length} entr${result.written.length === 1 ? "y" : "ies"}, left ${result.skipped} candidate(s)`,
      );
      for (const item of result.written) {
        console.log(`  ${item.action === "new" ? "new   " : "update"} ${item.id}  ${item.path}`);
      }
      for (const note of result.notes) console.log(`  note: ${note}`);
      console.log("\nCommit the entries before `forge freeze`, so they cross with this version.");
    });
}
