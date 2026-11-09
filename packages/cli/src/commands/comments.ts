import type { Command } from "commander";
import { CLOUD_HELP_GROUP } from "../cloud-auth.js";
import { applyTriage, archiveTag, setWindow, stageTriage } from "../comments.js";
import { type ImportSource, stageImport } from "../comments-import.js";
import { requireRepoRoot } from "../git.js";
import { resolveTrail } from "../resolution-trail.js";

export function registerCommentsCommand(program: Command): void {
  const comments = program.command("comments").description("stakeholder comment operations");
  const importCommand = comments
    .command("import")
    .description(
      "stage feedback from where stakeholders already talk — a Figma file's comments, a repository's issues — under .forge/triage/ for the same triage",
    );
  const registerImporter = (
    name: "figma" | "issues",
    source: ImportSource,
    inputHelp: string,
    settledHelp: string,
  ) =>
    importCommand
      .command(name)
      .argument("<input>", inputHelp)
      .option("--as <batch>", "the batch name under .forge/triage/ (default: <source>-<today>)")
      .option("--freeze <tag>", "the freeze this review was about, recorded on each feedback")
      .option("--include-settled", settledHelp)
      .description(
        `stage ${name === "figma" ? "a Figma file's comments" : "a repository's open issues"} for triage — nothing reaches the record until \`forge comments triage apply <batch>\``,
      )
      .action(
        async (input: string, opts: { as?: string; freeze?: string; includeSettled?: boolean }) => {
          const root = await requireRepoRoot();
          const result = await stageImport({
            root,
            source,
            input,
            batch: opts.as,
            freeze: opts.freeze,
            includeSettled: opts.includeSettled,
            log: console.log,
          });
          const left = [
            result.skipped.settled > 0
              ? `${result.skipped.settled} already settled at the source`
              : "",
            result.skipped.pullRequests > 0 ? `${result.skipped.pullRequests} pull request(s)` : "",
            result.skipped.alreadyInRecord > 0
              ? `${result.skipped.alreadyInRecord} already in the record`
              : "",
          ].filter(Boolean);
          if (result.count === 0) {
            console.log(
              `Nothing to triage${left.length > 0 ? ` (skipped: ${left.join(", ")})` : ""}.`,
            );
            return;
          }
          console.log(
            `Staged ${result.count} comment(s) at ${result.staged}${left.length > 0 ? ` (skipped: ${left.join(", ")})` : ""}. ` +
              `Disposition them with the forge-triage skill in your agent session, then run \`forge comments triage apply ${result.batch}\`.`,
          );
        },
      );
  registerImporter(
    "figma",
    "figma",
    "a saved comments export (GET /v1/files/:key/comments), or a file key / URL to fetch with FIGMA_TOKEN",
    "keep comments already resolved in Figma",
  );
  registerImporter(
    "issues",
    "issue",
    "a saved issues export (the REST list, or `gh issue list --json`), or owner/repo to fetch (GITHUB_TOKEN optional)",
    "keep closed issues",
  );

  const triage = comments
    .command("triage")
    .description(
      "stage and apply comment triage into the record's feedback/ and todos.md (spec/format.md)",
    );

  triage
    .argument("<tag>", "freeze tag whose comments to triage")
    .description(
      "stage a Forge Cloud review's new comments under .forge/triage/<tag>/ — `forge comments import` stages feedback from elsewhere without an account",
    )
    .action(async (tag: string) => {
      const result = await stageTriage({ tag, log: console.log });
      if (result.count === 0) {
        console.log("Nothing to triage — no unfetched comments.");
        return;
      }
      console.log(
        `Staged ${result.count} comment(s) at ${result.staged}. Disposition them with the forge-triage skill ` +
          `in your agent session, then run \`forge comments triage apply ${tag}\`.`,
      );
    });

  triage
    .command("apply")
    .argument("<tag>", "freeze tag (or imported batch name) whose staged comments to apply")
    .description(
      "write each staged comment's disposition (.forge/triage/<tag>/proposal.json) into feedback/ and todos.md, then mark them fetched",
    )
    .action(async (tag: string) => {
      const result = await applyTriage({ tag, log: console.log });
      console.log(
        `Applied ${result.count} comment(s) → ${result.feedbackIds.length} FEEDBACK item(s)` +
          (result.taskIds.length > 0 ? `, ${result.taskIds.length} task(s)` : "") +
          (result.questionIds.length > 0 ? `, ${result.questionIds.length} QUESTION(s)` : "") +
          (result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : "") +
          (result.withdrawn.length > 0
            ? `, ${result.withdrawn.length} withdrawn by their authors`
            : "") +
          `. Summary at ${result.staged}.`,
      );
    });

  // Registered last so `--help` lists the local commands first: commander
  // orders its groups by the first command in each.
  comments
    .command("archive")
    .helpGroup(CLOUD_HELP_GROUP)
    .argument("<tag>", "freeze tag whose snapshot should become read-only")
    .description("archive a snapshot: pins stay visible on the preview, new comments are refused")
    .action(async (tag: string) => {
      const result = await archiveTag({ tag });
      console.log(
        result.alreadyArchived
          ? `Snapshot for "${tag}" was already archived.`
          : `Archived "${tag}" — its preview is now read-only.`,
      );
    });

  comments
    .command("window")
    .helpGroup(CLOUD_HELP_GROUP)
    .argument("<tag>", "freeze tag whose feedback round has a deadline")
    .option("--closes <date>", "when the round stops taking comments (YYYY-MM-DD, or with a time)")
    .option("--clear", "remove the deadline and leave the round open-ended")
    .description("set, extend or clear the feedback window on a freeze")
    .action(async (tag: string, options: { closes?: string; clear?: boolean }) => {
      if (options.clear && options.closes) {
        throw new Error("pass either --closes or --clear, not both");
      }
      if (!options.clear && !options.closes) {
        throw new Error("pass --closes <date> to set a deadline, or --clear to remove one");
      }
      const result = await setWindow({
        tag,
        closes: options.clear ? null : (options.closes ?? ""),
      });
      if (!result.closesAt) {
        console.log(`Cleared the feedback window on "${tag}" — the round is open-ended again.`);
        return;
      }
      // Echoed in the creator's own zone and in UTC: they typed the first and
      // their reviewers are shown the second.
      console.log(
        `Feedback on "${tag}" closes ${new Date(result.closesAt).toLocaleString()} ` +
          `(${result.closesAt}).`,
      );
      console.log(
        "Reviewers see the deadline in the review banner. Extend it by running this again.",
      );
    });

  comments
    .command("resolve")
    .helpGroup(CLOUD_HELP_GROUP)
    .argument("<tag>", "the release that ships the addressed work")
    .description(
      'tell every earlier snapshot what became of its comments: declined ones carry the DDR, accepted ones whose task is done become "addressed in <tag>"',
    )
    .action(async (tag: string) => {
      const result = await resolveTrail({ tag, log: console.log });
      for (const warning of result.warnings) console.log(`warning: ${warning}`);
      if (result.addressed === 0 && result.declined === 0 && result.answered === 0) {
        console.log("Nothing to resolve — no settled review feedback to project.");
        return;
      }
      console.log(
        `Resolved ${result.synced} comment(s): ${result.addressed} addressed in ${tag}` +
          (result.declined > 0 ? `, ${result.declined} declined` : "") +
          (result.answered > 0 ? `, ${result.answered} question(s) answered` : "") +
          (result.unsynced === 0
            ? ". Old share links now show where each one landed."
            : `. The record has all of it; ${result.unsynced} snapshot(s) were not reached and are told on the next run.`),
      );
    });
}
