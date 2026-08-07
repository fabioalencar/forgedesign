import path from "node:path";
import type { Command } from "commander";
import { prototypeOutputDir } from "../build.js";
import { readFreezes } from "../freezes.js";
import { repoRoot } from "../git.js";
import { readProjectFile } from "../project.js";
import { publishBuild, withdrawPublished } from "../publish.js";

export function registerPublishCommand(program: Command): void {
  program
    .command("publish")
    .argument("<tag>", "the freeze tag to publish")
    .description("host a frozen build on Forge Cloud and get a link for a stakeholder")
    .option(
      "--force",
      "publish even if the build looks unsafe — a secret, or files swept in by mistake (.git, node_modules, .env)",
      false,
    )
    .action(async (tag: string, options: { force: boolean }) => {
      const root = (await repoRoot(process.cwd())) ?? process.cwd();

      const freezes = await readFreezes(root).catch(() => []);
      const freeze = freezes.find((entry) => entry.tag === tag);
      if (!freeze) {
        // Publishing something that was never frozen would host a build with no
        // commit behind it — the opposite of what a freeze is for.
        console.error(
          `forge publish: no freeze tagged "${tag}" — run \`forge freeze ${tag}\` first.`,
        );
        process.exitCode = 1;
        return;
      }

      const projectId = (await readProjectFile(root)).projectId;
      if (typeof projectId !== "string" || !projectId) {
        console.error(
          "forge publish: this repo has no projectId in forge.json — freeze once first.",
        );
        process.exitCode = 1;
        return;
      }

      const buildDir = await prototypeOutputDir(root);
      if (!buildDir) {
        console.error('forge publish: forge.json declares no "build" — nothing to host (DDR-052).');
        process.exitCode = 1;
        return;
      }

      console.log(`Publishing ${tag}…`);
      const outcome = await publishBuild({
        buildDir,
        projectId,
        repoName: path.basename(root),
        tag,
        snapshotId: freeze.snapshotId,
        force: options.force,
      });

      if (!outcome.ok) {
        console.error(`\nforge publish: ${outcome.refusal.error}`);
        process.exitCode = 1;
        return;
      }

      const { url, shortUrl, fileCount, freezesUsed } = outcome.result;
      // The short one first: it is the one that gets sent, and DDR-085's whole
      // argument is that a link read over a call or retyped off a phone should
      // be short while the URL that ends up in the address bar stays
      // self-describing. Both are printed so the creator can see they are the
      // same review.
      console.log(`\n  ${shortUrl ?? url}\n`);
      if (shortUrl) console.log(`  → ${url}\n`);
      console.log(
        `  ${fileCount} file(s) hosted · ${freezesUsed} freeze(s) published on this plan`,
      );
      console.log("\nSend the first link with the freeze's PIN to invite a review.");
    });

  program
    .command("unpublish")
    .argument("<tag>", "the published freeze to stop serving")
    .description("stop Forge Cloud serving a published freeze")
    .action(async (tag: string) => {
      const root = (await repoRoot(process.cwd())) ?? process.cwd();
      const projectId = (await readProjectFile(root)).projectId;
      if (typeof projectId !== "string" || !projectId) {
        console.error(
          "forge unpublish: this repo has no projectId in forge.json — nothing was published from here.",
        );
        process.exitCode = 1;
        return;
      }

      const outcome = await withdrawPublished({ projectId, tag });
      if (!outcome.ok) {
        console.error(`forge unpublish: ${outcome.refusal.error}`);
        process.exitCode = 1;
        return;
      }

      if (outcome.result.alreadyWithdrawn) {
        console.log(`${tag} was already withdrawn.`);
        return;
      }
      console.log(`Withdrew ${tag}.`);
      // Said plainly because both surprise people: the link does not break, and
      // the freeze still counts (DDR-086, DDR-077).
      console.log("  The link still resolves and now shows a withdrawal notice.");
      console.log("  It still counts against your plan — freezes count as ever published.");
    });
}
