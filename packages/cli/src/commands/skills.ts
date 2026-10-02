import { homedir } from "node:os";
import type { Command } from "commander";
import { SKILL_FILES } from "../generated/skills.js";
import { repoRoot } from "../git.js";
import { forgeHome } from "../registry.js";
import { installAgentsAdapter, installHomeSkills, installSkills, skillFiles } from "../skills.js";

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command("skills")
    .description("the agent instructions that drive the record");

  skills
    .command("install")
    .option("--agents", "also write the Codex adapter as a root AGENTS.md")
    .option(
      "--home",
      "link the skills into ~/.claude/skills and ~/.agents/skills, for every project",
    )
    .option(
      "--source <dir>",
      "with --home: link to a checkout's skills/ instead, so edits are live",
    )
    .description("copy the skills into .claude/skills/ so an agent session can run them")
    .action(async (options: { agents?: boolean; home?: boolean; source?: string }) => {
      if (options.source && !options.home) {
        console.error("forge skills install: --source only applies with --home");
        process.exitCode = 1;
        return;
      }
      if (options.home) {
        if (options.agents) {
          console.error(
            "forge skills install: --agents writes a project's AGENTS.md — run it without --home",
          );
          process.exitCode = 1;
          return;
        }
        await installHome(options.source);
        return;
      }

      const root = (await repoRoot(process.cwd())) ?? process.cwd();
      const result = await installSkills(root);

      const changed = result.files.filter((file) => file.outcome !== "kept");
      if (changed.length === 0) {
        console.log(`forge skills install: already up to date (${result.files.length} skill(s)).`);
      } else {
        for (const file of changed)
          console.log(`  ${file.outcome === "written" ? "+" : "~"} ${file.relPath}`);
        console.log(
          `\nInstalled ${changed.length} of ${result.files.length} skill(s) into .claude/skills/.`,
        );
      }
      for (const relPath of result.removed)
        console.log(`  - ${relPath} (renamed to forge-*; this was an earlier install)`);

      for (const conflict of result.conflicts) {
        // Named rather than merged: this command cannot know whether the
        // collision is a stale copy or a skill the user wrote themselves.
        console.warn(
          `warning: kept your own ${conflict} — delete it and rerun to take the version this CLI ships.`,
        );
      }

      if (options.agents) {
        const agents = await installAgentsAdapter(root);
        if (agents.outcome === "kept") {
          console.warn(
            "\nwarning: kept your existing AGENTS.md — a repo's own agent instructions are not this\n" +
              "  command's to replace. Copy from `forge skills show agents` if you want the adapter.",
          );
        } else {
          console.log(`\n  ${agents.outcome === "written" ? "+" : "~"} AGENTS.md (Codex adapter)`);
        }
      }

      console.log("\nRun them from an agent session in this repo — start with `forge-init`.");
    });

  skills
    .command("show")
    .argument("<name>", "a skill name, or `agents` for the Codex adapter")
    .description("print a skill without writing anything")
    .action((name: string) => {
      const body = name === "agents" ? SKILL_FILES["AGENTS.md"] : SKILL_FILES[`${name}/SKILL.md`];
      if (!body) {
        const available = Object.keys(skillFiles())
          .map((relPath) => relPath.replace("/SKILL.md", ""))
          .join(", ");
        console.error(`forge skills show: no skill "${name}" — available: ${available}, agents`);
        process.exitCode = 1;
        return;
      }
      console.log(body);
    });
}

async function installHome(source: string | undefined): Promise<void> {
  let result: Awaited<ReturnType<typeof installHomeSkills>>;
  try {
    result = await installHomeSkills({ home: homedir(), forgeHome: forgeHome(), source });
  } catch (error) {
    console.error(`forge skills install: ${(error as Error).message}`);
    process.exitCode = 1;
    return;
  }

  if (result.store) console.log(`Skills written to ${result.store}.`);
  const changed = result.links.filter((link) => link.outcome !== "kept");
  for (const link of changed)
    console.log(`  ${link.outcome === "linked" ? "+" : "~"} ${link.path} -> ${link.target}`);
  for (const entry of result.removed)
    console.log(`  - ${entry} (a link to a skill's pre-forge-* name that no longer resolves)`);
  console.log(
    changed.length === 0
      ? `\nAlready linked (${result.links.length} link(s)).`
      : `\nLinked ${changed.length} of ${result.links.length + result.conflicts.length} skill(s) for every project.`,
  );

  for (const conflict of result.conflicts) {
    console.warn(
      `warning: kept ${conflict} — it is not a link or a copy this command made. Delete it and rerun to link the Forge skill there.`,
    );
  }
  if (!source)
    console.log("Rerun after upgrading the CLI — the links stay, the skills move with it.");
}
