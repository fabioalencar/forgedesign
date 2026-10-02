import type { Command } from "commander";
import { runCheck } from "../check.js";

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .argument(
      "<tag>",
      "the version these reports are for — the tag the next `forge freeze` will cut",
    )
    .option("--json", "machine-readable output")
    .description(
      "run doctor and every checker in forge.json#checks, and keep each report in the record at design/checks/<tag>/ — what `forge freeze --require-check` looks for",
    )
    .action(async (tag: string, options: { json?: boolean }) => {
      const result = await runCheck({ tag, log: options.json ? undefined : console.log });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      for (const report of result.reports) {
        const findings =
          report.findings === 0
            ? "no findings"
            : `${report.findings} finding(s)${report.errors > 0 ? `, ${report.errors} error(s)` : ""}`;
        console.log(
          `  ${report.checker}: ${findings}${report.score !== null ? ` · score ${report.score}` : ""} → ${report.path}`,
        );
      }
      console.log(
        `forge check: ${result.reports.length} report(s) for ${tag} at ${result.commit.slice(0, 7)} in ${result.dir}/. ` +
          `Commit them, then \`forge freeze ${tag} --require-check\` will accept this commit.`,
      );
    });
}
