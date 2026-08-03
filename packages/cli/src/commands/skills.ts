import type { Command } from "commander";
import { SKILL_FILES } from "../generated/skills.js";
import { repoRoot } from "../git.js";
import { installAgentsAdapter, installSkills, skillFiles } from "../skills.js";

export function registerSkillsCommand(program: Command): void {
  const skills = program
    .command("skills")
    .description("the agent instructions that drive the record");

  skills
    .command("install")
    .option("--agents", "also write the Codex adapter as a root AGENTS.md")
    .description("copy the skills into .claude/skills/ so an agent session can run them")
    .action(async (options: { agents?: boolean }) => {
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
