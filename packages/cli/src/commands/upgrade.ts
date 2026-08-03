import type { Command } from "commander";
import { readRecordVersion } from "../record-version.js";
import { upgradeRecord, upgradeRecordToV02 } from "../upgrade.js";

export function registerUpgradeCommand(program: Command): void {
  program
    .command("upgrade")
    .argument("[path]", "record root to migrate (defaults to the current directory)")
    // Defaults to the current format, not to the next hop. DDR-095 makes every
    // other command refuse a pre-0.2 record with "run `forge upgrade --to 0.2`",
    // so a bare `forge upgrade` that stopped at 0.1 would leave the user holding
    // a record nothing will serve — a migration into a dead end.
    .option("--to <version>", "target format version: 0.1 or 0.2", "0.2")
    .option("--prune", "delete the sources the migration superseded", false)
    .description(
      "migrate a record forward to the current format — additive by default, and no source is deleted without --prune",
    )
    .action(async (targetPath: string | undefined, options: { to: string; prune: boolean }) => {
      const root = targetPath ?? process.cwd();
      if (options.to === "0.2") {
        await runV02(root, options.prune);
        return;
      }
      if (options.to !== "0.1") {
        console.error(
          `forge upgrade: unknown target version "${options.to}" (expected 0.1 or 0.2)`,
        );
        process.exitCode = 1;
        return;
      }

      const result = await upgradeRecord(root, { prune: options.prune });

      if (result.written.length === 0) {
        console.log(
          "forge upgrade: nothing to migrate (already up to date, or no v1 sources found)",
        );
      } else {
        console.log(`forge upgrade: wrote ${result.written.join(", ")}`);
        if (result.migratedTaskCount > 0) {
          console.log(`  migrated ${result.migratedTaskCount} task(s) into Todos.md`);
        }
      }
      if (result.skipped.length > 0) {
        console.log(`  kept existing: ${result.skipped.join(", ")}`);
      }
      if (result.droppedBlocks > 0) {
        console.warn(
          `warning: ${result.droppedBlocks} line(s) of prose between tasks were not carried over —\n` +
            "  the ledger holds tasks, and phase headings moved onto the rows as `phase:`.\n" +
            "  Move anything you still want into the ledger's preamble; Git has the original.",
        );
      }
      if (result.rewritten.length > 0) {
        console.log(
          `  rewrote T-### references in ${result.rewritten.length} decision(s) to their new ids`,
        );
      }
      for (const { target, variant } of result.blocked) {
        console.warn(
          `warning: could not write ${target} — ${variant} differs from it only by case, ` +
            `and on this filesystem they are the same path. Rename ${variant}, then rerun.`,
        );
      }
      reportSuperseded(result.superseded, result.pruned, "v1", "the v0.1 record");
      // 0.1 is a stage, not a destination (DDR-095): doctor and every writer
      // refuse what this run just produced. Saying so here is the difference
      // between a two-step migration and a record that stopped halfway.
      console.log(
        "\nformat 0.1 is an intermediate stage — `forge doctor` and the record\n" +
          "writers only serve 0.2. Run `forge upgrade --to 0.2` to finish.",
      );
      if (result.blocked.length > 0) process.exitCode = 1;
    });
}

/**
 * The loud report the creator asked for (T-259): say plainly that the old files
 * are now a second home for the same facts, and how to remove them. Printed on
 * every run that still has superseded sources, not just the one that migrated —
 * the whole point is that the in-between state doesn't go quiet.
 */
function reportSuperseded(
  superseded: string[],
  pruned: string[],
  era: string,
  destination: string,
): void {
  if (pruned.length > 0) {
    console.log(`\nremoved ${pruned.length} superseded ${era} source(s):`);
    for (const source of pruned) console.log(`  - ${source}`);
    return;
  }
  if (superseded.length === 0) return;
  console.log(`\nThese ${era} sources are superseded by ${destination}:`);
  for (const source of superseded) console.log(`  ${source}`);
  console.log(
    "They are still on disk, so the same fact now has two homes. Rerun with --prune to remove\n" +
      "them once you have reviewed the migration; Git keeps the history either way.",
  );
}

async function runV02(root: string, prune: boolean): Promise<void> {
  // A repo two formats behind needs both hops, and asking the user to discover
  // that by running the command twice is how "run `forge upgrade --to 0.2`"
  // becomes advice that does not work. The v1 stage is skipped on a record that
  // is already current — it reads `todo/todo.md`, which a migrated repo may
  // still have on disk until `--prune`, and re-running it there would resurrect
  // root files the bundle has replaced.
  const before = await readRecordVersion(root);
  if (before.kind !== "current") {
    const v1 = await upgradeRecord(root, { prune });
    if (v1.written.length > 0) {
      console.log(`forge upgrade: migrated v1 sources first — wrote ${v1.written.join(", ")}`);
      if (v1.migratedTaskCount > 0) {
        console.log(`  migrated ${v1.migratedTaskCount} task(s) into Todos.md`);
      }
      reportSuperseded(v1.superseded, v1.pruned, "v1", "the v0.1 record");
    }
    for (const { target, variant } of v1.blocked) {
      console.warn(
        `warning: could not write ${target} — ${variant} differs from it only by case, ` +
          `and on this filesystem they are the same path. Rename ${variant}, then rerun.`,
      );
    }
    if (v1.blocked.length > 0) {
      process.exitCode = 1;
      return;
    }
  }

  const result = await upgradeRecordToV02(root, { prune });

  if (result.written.length > 0) {
    console.log(`forge upgrade: wrote ${result.written.length} file(s) into design/`);
    for (const relPath of result.written) console.log(`  + ${relPath}`);
    if (result.skipped.length > 0) {
      console.log(`  kept ${result.skipped.length} file(s) that already existed`);
    }
  } else if (result.skipped.length > 0) {
    console.log(`forge upgrade: already migrated — ${result.skipped.length} file(s) under design/`);
  } else {
    console.log("forge upgrade: nothing to migrate (no v0.1 record found)");
  }

  for (const warning of result.warnings) console.warn(`warning: ${warning}`);

  reportSuperseded(result.superseded, result.pruned, "v0.1", "the record under design/");
}
