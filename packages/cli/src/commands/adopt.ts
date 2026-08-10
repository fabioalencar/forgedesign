import type { Command } from "commander";
import type { Candidate } from "../adopt.js";
import {
  COMPLIANCE_NOTE,
  DESTINATION_HEADINGS,
  groupCandidates,
  scanForAdoption,
  TRUTH_NOTE,
} from "../adopt.js";

export function registerAdoptCommand(program: Command): void {
  program
    .command("adopt")
    .description(
      "survey documentation this repo already has and report what could become part of the record — reads only, writes nothing",
    )
    .option("--limit <n>", "how many files to report on", "200")
    .action(async (options: { limit: string }) => {
      const limit = Number.parseInt(options.limit, 10);
      if (!Number.isFinite(limit) || limit < 1) {
        console.error(`forge adopt: --limit must be a positive number — got "${options.limit}"`);
        process.exitCode = 1;
        return;
      }

      let report: Awaited<ReturnType<typeof scanForAdoption>>;
      try {
        report = await scanForAdoption(process.cwd(), limit);
      } catch (error) {
        console.error(`forge adopt: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
      }

      if (report.candidates.length === 0) {
        console.log("forge adopt: no documentation outside the record to consider.");
        console.log(`\n${COMPLIANCE_NOTE}`);
        return;
      }

      const groups = groupCandidates(report.candidates);
      console.log(
        `forge adopt: ${report.candidates.length} file(s) outside the record, grouped by where each could go.\n`,
      );

      for (const [destination, group] of groups) {
        console.log(`${DESTINATION_HEADINGS[destination]}\n`);
        // Grouped by reason rather than repeated per file: on a real repo the
        // decisions folder alone is a dozen files, and printing the same two
        // lines beside each one buries the list they are about.
        for (const [reason, files] of byReason(group)) {
          console.log(`  ${reason.because}`);
          console.log(`  → ${reason.next}\n`);
          for (const candidate of files) {
            const dated = candidate.dated ? `   · ${candidate.dated}` : "";
            console.log(`      ${candidate.file}${dated}`);
          }
          console.log("");
        }
      }

      if (report.recordRoot === null) {
        console.log("There is no record here yet — `forge init` first, then promote into it.\n");
      }
      console.log(TRUTH_NOTE);
      console.log(`\n${COMPLIANCE_NOTE}`);
    });
}

/** Files sharing a classification, so the reason is stated once above them. */
function byReason(group: Candidate[]): Array<[{ because: string; next: string }, Candidate[]]> {
  const buckets = new Map<string, { because: string; next: string; files: Candidate[] }>();
  for (const candidate of group) {
    const key = `${candidate.because}\u0000${candidate.next}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.files.push(candidate);
    else buckets.set(key, { because: candidate.because, next: candidate.next, files: [candidate] });
  }
  return [...buckets.values()].map((bucket) => [
    { because: bucket.because, next: bucket.next },
    bucket.files,
  ]);
}
