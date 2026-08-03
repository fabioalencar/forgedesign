// `forge question add` (T-282) — the CLI write path for open questions.
//
// The rule everywhere else is "skills talk, CLI writes": judgment happens in
// the agent session, and a `forge <thing>` command is what actually touches the
// record, so ids and enums stay deterministic. `decisions/` has `forge ddr
// apply` and feedback has `forge triage apply`; questions had nothing, so the
// forge-init skill hand-wrote `QUESTION-###` entries and leaned on doctor to
// catch a duplicate afterwards. That is validation after the fact rather than a
// writer that cannot get it wrong.
//
// Unlike `ddr apply` this takes arguments rather than a staged JSON file. The
// staging step exists to carry the five prose sections a decision needs; a
// question is one sentence, and making a skill write a file to pass a sentence
// is ceremony that buys nothing.

import { promises as fs } from "node:fs";
import path from "node:path";
import { nextId, scanBundle, withFrontmatter } from "@forgedesign/format";
import { writeBundleIndex } from "./bundle-index.js";
import { todayIsoDate } from "./freezes.js";
import { requireCurrentRecord } from "./record-version.js";

export const QUESTION_STATUSES = ["open", "resolved", "dropped"] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export interface NewQuestion {
  /** the question itself, as a sentence */
  question: string;
  /** what it bears on — a bundle-relative path or an ID */
  context?: string;
  /** when it was raised; defaults to today */
  date?: string;
  status?: QuestionStatus;
  /** what resolved it, when it is being recorded already-answered */
  link?: string;
}

export interface AddQuestionResult {
  id: string;
  /** repo-relative path written */
  path: string;
}

export function isQuestionStatus(value: string): value is QuestionStatus {
  return (QUESTION_STATUSES as readonly string[]).includes(value);
}

/**
 * Writes a `QUESTION-###` into whichever record this repo has, allocating the
 * id from what is already there. A `resolved` question with no link is refused:
 * spec §5 says resolution names what answered it, and a resolved question
 * pointing at nothing is the shape doctor exists to catch.
 */
export async function addRecordQuestion(
  root: string,
  input: NewQuestion,
): Promise<AddQuestionResult> {
  const question = input.question.trim();
  if (question === "") throw new Error("a question needs text");

  const status: QuestionStatus = input.status ?? "open";
  if (status === "resolved" && !input.link) {
    throw new Error(
      "a resolved question needs --link (the DDR-###, FEEDBACK-### or TASK-### that answered it)",
    );
  }

  const date = input.date ?? todayIsoDate();
  // DDR-095: the root-file `OpenQuestions.md` writer is gone with the format it
  // wrote for; an older record is told to upgrade.
  const { recordRoot } = await requireCurrentRecord(root);
  const bundle = await scanBundle(root, { recordRoot });

  const allocated = bundle.concepts.flatMap((c) => (c.type === "Question" && c.id ? [c.id] : []));
  const id = nextId(allocated, "QUESTION");
  const relPath = path.join(recordRoot, "questions", `${id}.md`);
  await fs.mkdir(path.join(root, recordRoot, "questions"), { recursive: true });
  await fs.writeFile(
    path.join(root, relPath),
    withFrontmatter(
      {
        type: "Question",
        id,
        title: question,
        date,
        question_status: status,
        context: input.context,
        resolution: input.link,
      },
      "",
    ),
    "utf8",
  );
  // The index is derived from the concept listing, so the writer that adds a
  // concept keeps it true (T-300).
  await writeBundleIndex(root);
  return { id, path: relPath };
}
