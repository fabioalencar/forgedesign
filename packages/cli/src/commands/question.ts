import type { Command } from "commander";
import { addRecordQuestion, isQuestionStatus, QUESTION_STATUSES } from "../questions.js";
import { openTaskLedger } from "../task-ledger.js";

export function registerQuestionCommand(program: Command): void {
  program
    .command("question")
    .argument("<question>", "the question, as a sentence")
    .option("--context <ref>", "what it bears on — a record path or an ID")
    .option("--date <date>", "when it was raised (YYYY-MM-DD); defaults to today")
    .option("--status <status>", `one of ${QUESTION_STATUSES.join(", ")}`, "open")
    .option("--link <id>", "what answered it, when recording a resolved question")
    .description(
      "record an open question — the write path the forge-init and intake skills use instead of hand-writing QUESTION-### entries",
    )
    .action(
      async (
        question: string,
        opts: { context?: string; date?: string; status: string; link?: string },
      ) => {
        if (!isQuestionStatus(opts.status)) {
          console.error(
            `forge question: status must be one of ${QUESTION_STATUSES.join(", ")} — got "${opts.status}"`,
          );
          process.exitCode = 1;
          return;
        }
        const result = await addRecordQuestion(process.cwd(), {
          question,
          context: opts.context,
          date: opts.date,
          status: opts.status,
          link: opts.link,
        });
        console.log(`forge question: wrote ${result.id} into ${result.path}`);
      },
    );
}

export function registerTaskCommand(program: Command): void {
  const task = program.command("task").description("the task ledger (spec/format.md §5)");

  task
    .command("add")
    .argument("<title>", "what the task is")
    .option("--genesis <ref>", "what caused it — a FEEDBACK/QUESTION/DDR id, or a dated source")
    .option("--phase <name>", 'the arc it belongs to, e.g. "Phase 46 — Dogfood gate"')
    .option("--notes <text>", "anything the title cannot carry")
    .description("add a task to whichever ledger this repo has, with the next id allocated from it")
    .action(async (title: string, opts: { genesis?: string; phase?: string; notes?: string }) => {
      const ledger = await openTaskLedger(process.cwd());
      if (ledger === null) {
        console.error(
          "forge task add: no task ledger found — run `forge init` (or `forge upgrade`) first.",
        );
        process.exitCode = 1;
        return;
      }
      const id = ledger.add({ title, genesis: opts.genesis, phase: opts.phase, notes: opts.notes });
      await ledger.save();
      console.log(`forge task add: wrote ${id} into ${ledger.relPath}`);
    });
}
