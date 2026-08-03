import type { Command } from "commander";
import { type DoctorFinding, type DoctorResult, runDoctor } from "../doctor.js";

function formatFindings(findings: DoctorFinding[]): string {
  return findings
    .map((f) => `  [${f.severity}] ${f.rule}${f.file ? ` (${f.file})` : ""}: ${f.message}`)
    .join("\n");
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .argument("[path]", "record root to validate (defaults to the current directory)")
    .option("--json", "machine-readable output")
    .option(
      "--base <ref>",
      "git ref to compare accepted decisions against (default HEAD; use the merge target in CI)",
    )
    .description(
      "validate the Design Record: unique ids, resolvable links, enum validity, disposition rules, derived-file markers, accepted-DDR immutability, formatVersion",
    )
    .action(async (targetPath: string | undefined, options: { json?: boolean; base?: string }) => {
      const result: DoctorResult = await runDoctor(targetPath ?? process.cwd(), {
        base: options.base,
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (result.exitCode === 0) {
        console.log("forge doctor: clean");
      } else {
        console.log(`forge doctor: ${result.findings.length} finding(s)`);
        console.log(formatFindings(result.findings));
      }

      process.exitCode = result.exitCode;
    });
}
