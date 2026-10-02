import type { Command } from "commander";
import { applyReview } from "../review.js";

export function registerReviewCommand(program: Command): void {
  const review = program
    .command("review")
    .description("the forge-review skill's write path — rubric findings into design/feedback/");

  review
    .command("apply")
    .argument("[path]", "record root (defaults to the current directory)")
    .description(
      "validate staged rubric findings (.forge/review/findings.json) and write them as source: scan feedback",
    )
    .action(async (targetPath: string | undefined) => {
      const result = await applyReview(targetPath ?? process.cwd());
      console.log(
        `forge review apply: wrote ${result.ids.length} finding(s) — ${result.ids.join(", ")}`,
      );
      // Said plainly, because a scan that looked like a verdict would be the
      // thing DDR-108 refused: these are pending until a human dispositions
      // them, and nothing here blocked anything.
      console.log("They are pending feedback — disposition them like any other.");
    });
}
