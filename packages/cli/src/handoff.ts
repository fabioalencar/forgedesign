// Handoff pack generation (spec §2 step 7): one content model assembled from
// the repo's artifacts, rendered to both PDF (pdfkit) and docx (docx) into
// handoff/<tag>/ (DDR-012).

import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { decisionParagraph, type ParsedConcept, scanBundle } from "@forgedesign/format";
import { Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import PDFDocument from "pdfkit";
import { bundleRootOf } from "./bundle-index.js";
import { decisionAt } from "./feature-log.js";
import { readFreezes } from "./freezes.js";

export interface HandoffInputs {
  tag: string;
  message: string;
  date: string;
  previewUrl: string | null;
  storybookUrl: string | null;
}

export interface DdrSummary {
  file: string;
  title: string;
  date: string;
  decision: string;
}

/** An open question at freeze time — what an engineer asks about first (TASK-464). */
export interface OpenQuestion {
  id: string;
  title: string;
  date: string | null;
  /** what it bears on, when the question says */
  context: string | null;
}

/** One check report on the version being handed over (TASK-464, DDR-127). */
export interface CheckSummary {
  checker: string;
  findings: number;
  errors: number;
  warnings: number;
  score: number | null;
}

export interface HandoffContent {
  projectName: string;
  inputs: HandoffInputs;
  previousTag: string | null;
  glossary: string[];
  userStories: string[] | null;
  ddrs: DdrSummary[];
  openQuestions: OpenQuestion[];
  checks: CheckSummary[];
}

const stripMd = (line: string) => line.replace(/\*\*/g, "").replace(/`/g, "");

async function readLines(file: string): Promise<string[] | null> {
  try {
    return (await fs.readFile(file, "utf8")).split("\n");
  } catch {
    return null;
  }
}

function bulletsOf(lines: string[]): string[] {
  return lines
    .filter((l) => /^\s*-\s+/.test(l))
    .map((l) => stripMd(l.replace(/^\s*-\s+/, "").trim()));
}

const byId = (a: ParsedConcept, b: ParsedConcept) => (a.id ?? "").localeCompare(b.id ?? "");

/**
 * Accepted decisions the previous freeze did not have as accepted — all of
 * them on a first freeze. Read from the bundle as it stands (the tree is clean
 * at freeze, so that is the tag) and compared with the files at the previous
 * tag, so a decision that only gained `amended_by` since is not re-listed.
 *
 * Until TASK-464 this read a root `decisions/` in the pre-0.2 prose format, so
 * on every current record the section said "None in this range" — the six
 * login-demo packs prove it.
 */
async function decisionsSince(
  repoRoot: string,
  recordRoot: string,
  concepts: readonly ParsedConcept[],
  previousTag: string | null,
): Promise<DdrSummary[]> {
  const accepted = concepts
    .filter(
      (concept) =>
        concept.type === "Decision" &&
        concept.id &&
        concept.id !== "DDR-000" &&
        concept.domainStatus?.value === "accepted",
    )
    .sort(byId);
  const summaries: DdrSummary[] = [];
  for (const concept of accepted) {
    if (previousTag) {
      const before = await decisionAt(
        repoRoot,
        previousTag,
        path.join(recordRoot, concept.relPath),
      );
      if (before?.accepted) continue;
    }
    summaries.push({
      file: concept.relPath,
      title: `${concept.id} — ${concept.title ?? concept.id}`,
      date: concept.date ?? "",
      decision: stripMd(decisionParagraph(concept.body).replace(/\s*\n\s*/g, " ")),
    });
  }
  return summaries;
}

/** Every question still open, in id order — the record's own doubts, handed over with the version. */
function openQuestionsOf(concepts: readonly ParsedConcept[]): OpenQuestion[] {
  return concepts
    .filter(
      (concept) =>
        concept.type === "Question" && concept.id && concept.domainStatus?.value === "open",
    )
    .sort(byId)
    .map((concept) => ({
      id: concept.id as string,
      title: concept.title ?? (concept.id as string),
      date: concept.date,
      context: typeof concept.frontmatter.context === "string" ? concept.frontmatter.context : null,
    }));
}

/** The check reports written for this tag — what was checked before it was frozen. */
function checksOf(concepts: readonly ParsedConcept[], tag: string): CheckSummary[] {
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return concepts
    .filter((concept) => concept.type === "Check" && concept.relPath.startsWith(`checks/${tag}/`))
    .sort((a, b) => a.relPath.localeCompare(b.relPath))
    .map((concept) => ({
      checker:
        typeof concept.frontmatter.checker === "string"
          ? concept.frontmatter.checker
          : concept.relPath,
      findings: count(concept.frontmatter.findings),
      errors: count(concept.frontmatter.errors),
      warnings: count(concept.frontmatter.warnings),
      score: typeof concept.frontmatter.score === "number" ? concept.frontmatter.score : null,
    }));
}

/**
 * Glossary and user stories, from whichever layout holds them. Before this the
 * pack read only `artifacts/` — the v1 stubs `forge init` used to scaffold — so
 * a stakeholder's handoff showed "Example term — its definition." while the
 * real glossary sat unread one directory up (T-256).
 */
async function collectReference(
  repoRoot: string,
  previousTag: string | null,
  tag: string,
): Promise<Pick<HandoffContent, "glossary" | "userStories" | "ddrs" | "openQuestions" | "checks">> {
  const recordRoot = await bundleRootOf(repoRoot);
  if (recordRoot !== null) {
    const bundle = await scanBundle(repoRoot, { recordRoot });
    const terms = bundle.concepts
      .filter((concept) => concept.type === "Term")
      .map((concept) => {
        const definition = concept.description ?? concept.body.trim().split("\n")[0] ?? "";
        return definition
          ? `${concept.title ?? concept.relPath} — ${definition}`
          : (concept.title ?? "");
      })
      .filter((line) => line !== "");
    const stories = bundle.concepts
      .filter((concept) => concept.type === "Story")
      .map((concept) => concept.title ?? "")
      .filter((line) => line !== "");
    return {
      glossary: terms,
      userStories: stories.length > 0 ? stories : null,
      ddrs: await decisionsSince(repoRoot, recordRoot, bundle.concepts, previousTag),
      openQuestions: openQuestionsOf(bundle.concepts),
      checks: checksOf(bundle.concepts, tag),
    };
  }

  const v01Glossary = await readLines(path.join(repoRoot, "Glossary.md"));
  const v01Stories = await readLines(path.join(repoRoot, "UserStories.md"));
  const glossaryLines =
    v01Glossary ?? (await readLines(path.join(repoRoot, "artifacts/glossary.md")));
  const storyLines =
    v01Stories ?? (await readLines(path.join(repoRoot, "artifacts/user-stories.md")));
  return {
    glossary: glossaryLines ? bulletsOf(glossaryLines) : [],
    userStories: storyLines ? bulletsOf(storyLines) : null,
    ddrs: [],
    openQuestions: [],
    checks: [],
  };
}

export async function collectHandoffContent(
  repoRoot: string,
  inputs: HandoffInputs,
): Promise<HandoffContent> {
  const freezes = await readFreezes(repoRoot);
  const previousTag = freezes.at(-1)?.tag ?? null;
  const reference = await collectReference(repoRoot, previousTag, inputs.tag);

  return {
    projectName: path.basename(repoRoot),
    inputs,
    previousTag,
    ...reference,
  };
}

/** `QUESTION-004 · Can tier names change without legal review? (2026-07-19, bears on DDR-047)` */
function questionLine(question: OpenQuestion): string {
  const parts = [question.date, question.context ? `bears on ${question.context}` : null].filter(
    (part): part is string => part !== null,
  );
  return `${question.id} · ${question.title}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

/** `lint — 1 error, 2 warnings · score 91`, or `doctor — no findings`. */
function checkLine(check: CheckSummary): string {
  const info = check.findings - check.errors - check.warnings;
  const parts = [
    check.errors > 0 ? `${check.errors} error${check.errors === 1 ? "" : "s"}` : "",
    check.warnings > 0 ? `${check.warnings} warning${check.warnings === 1 ? "" : "s"}` : "",
    info > 0 ? `${info} info` : "",
  ].filter(Boolean);
  const findings = parts.length === 0 ? "no findings" : parts.join(", ");
  return `${check.checker} — ${findings}${check.score !== null ? ` · score ${check.score}` : ""}`;
}

// --- renderers ---

async function renderPdf(content: HandoffContent, file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const doc = new PDFDocument({
      margin: 54,
      info: { Title: `${content.projectName} — ${content.inputs.tag}` },
    });
    const stream = createWriteStream(file);
    doc.pipe(stream);

    const h1 = (t: string) =>
      doc.moveDown(0.6).fontSize(16).font("Helvetica-Bold").text(t).moveDown(0.3);
    const body = (t: string) => doc.fontSize(10).font("Helvetica").text(t);
    const bullet = (t: string) => doc.fontSize(10).font("Helvetica").text(`• ${t}`, { indent: 12 });

    doc.fontSize(22).font("Helvetica-Bold").text(`${content.projectName} — ${content.inputs.tag}`);
    doc
      .fontSize(10)
      .font("Helvetica")
      .fillColor("#555")
      .text(`Frozen ${content.inputs.date} · ${content.inputs.message}`)
      .fillColor("#000");

    h1("Links");
    body(`Preview: ${content.inputs.previewUrl ?? "not deployed"}`);
    body(`Storybook: ${content.inputs.storybookUrl ?? "not deployed"}`);

    h1("Glossary");
    if (content.glossary.length === 0) body("No glossary entries yet.");
    for (const entry of content.glossary) bullet(entry);

    h1("User stories");
    if (!content.userStories) body("No user stories in this record yet.");
    else for (const story of content.userStories) bullet(story);

    h1(
      content.previousTag
        ? `Decisions accepted since ${content.previousTag}`
        : "Accepted decisions",
    );
    if (content.ddrs.length === 0) body("None in this range.");
    for (const ddr of content.ddrs) {
      doc.moveDown(0.3).fontSize(11).font("Helvetica-Bold").text(`${ddr.title} (${ddr.date})`);
      body(ddr.decision);
    }

    // What the record does not know yet is as much a handoff as what it does:
    // an engineer who meets the doubt in the pack does not rediscover it in a
    // sprint (TASK-464).
    h1("Open questions");
    if (content.openQuestions.length === 0) body("None open at this freeze.");
    for (const question of content.openQuestions) bullet(questionLine(question));

    // What was checked before this version was frozen, and what each checker
    // found — the record's own reports, not a claim the pack makes (DDR-127).
    h1("Checks");
    if (content.checks.length === 0) body("No check reports for this version.");
    for (const check of content.checks) bullet(checkLine(check));

    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}

async function renderDocx(content: HandoffContent, file: string): Promise<void> {
  const children: Paragraph[] = [];
  const heading = (text: string) =>
    children.push(new Paragraph({ text, heading: HeadingLevel.HEADING_1 }));
  const body = (text: string) => children.push(new Paragraph({ text }));
  const bullet = (text: string) => children.push(new Paragraph({ text, bullet: { level: 0 } }));
  const link = (label: string, href: string | null) =>
    children.push(
      new Paragraph({
        children: href
          ? [
              new TextRun(`${label}: `),
              new ExternalHyperlink({
                children: [new TextRun({ text: href, style: "Hyperlink" })],
                link: href,
              }),
            ]
          : [new TextRun(`${label}: not deployed`)],
      }),
    );

  children.push(
    new Paragraph({
      text: `${content.projectName} — ${content.inputs.tag}`,
      heading: HeadingLevel.TITLE,
    }),
    new Paragraph({ text: `Frozen ${content.inputs.date} · ${content.inputs.message}` }),
  );
  heading("Links");
  link("Preview", content.inputs.previewUrl);
  link("Storybook", content.inputs.storybookUrl);

  heading("Glossary");
  if (content.glossary.length === 0) body("No glossary entries yet.");
  for (const entry of content.glossary) bullet(entry);

  heading("User stories");
  if (!content.userStories) body("No user stories in this record yet.");
  else for (const story of content.userStories) bullet(story);

  heading(
    content.previousTag ? `Decisions accepted since ${content.previousTag}` : "Accepted decisions",
  );
  if (content.ddrs.length === 0) body("None in this range.");
  for (const ddr of content.ddrs) {
    children.push(
      new Paragraph({ text: `${ddr.title} (${ddr.date})`, heading: HeadingLevel.HEADING_2 }),
    );
    body(ddr.decision);
  }

  heading("Open questions");
  if (content.openQuestions.length === 0) body("None open at this freeze.");
  for (const question of content.openQuestions) bullet(questionLine(question));

  heading("Checks");
  if (content.checks.length === 0) body("No check reports for this version.");
  for (const check of content.checks) bullet(checkLine(check));

  const doc = new Document({ sections: [{ children }] });
  await fs.writeFile(file, await Packer.toBuffer(doc));
}

export async function generateHandoffPack(
  repoRoot: string,
  inputs: HandoffInputs,
): Promise<{ dir: string; files: string[] }> {
  const content = await collectHandoffContent(repoRoot, inputs);
  const dir = path.join(repoRoot, "handoff", inputs.tag);
  await fs.mkdir(dir, { recursive: true });
  const pdf = path.join(dir, `handoff-${inputs.tag}.pdf`);
  const docxFile = path.join(dir, `handoff-${inputs.tag}.docx`);
  await renderPdf(content, pdf);
  await renderDocx(content, docxFile);
  return { dir, files: [pdf, docxFile] };
}
