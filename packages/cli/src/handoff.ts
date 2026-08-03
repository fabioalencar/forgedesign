// Handoff pack generation (spec §2 step 7): one content model assembled from
// the repo's artifacts, rendered to both PDF (pdfkit) and docx (docx) into
// handoff/<tag>/ (DDR-012).

import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { scanBundle } from "@forgedesign/format";
import { Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import PDFDocument from "pdfkit";
import { bundleRootOf } from "./bundle-index.js";
import { readFreezes } from "./freezes.js";
import { git } from "./git.js";

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

export interface HandoffContent {
  projectName: string;
  inputs: HandoffInputs;
  previousTag: string | null;
  glossary: string[];
  userStories: string[] | null;
  ddrs: DdrSummary[];
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

function parseDdr(file: string, text: string): DdrSummary | null {
  if (!/^\s*-\s*\*\*Status\*\*:\s*accepted\s*$/m.test(text)) return null;
  const title = stripMd(text.split("\n")[0]?.replace(/^#\s*/, "") ?? file);
  const date = text.match(/^\s*-\s*\*\*Date\*\*:\s*(.+)$/m)?.[1]?.trim() ?? "";
  const decisionMatch = text.match(/^## Decision\s*\n([\s\S]*?)(?:\n## |$)/m);
  const decision = stripMd((decisionMatch?.[1] ?? "").trim().replace(/\s*\n\s*/g, " "));
  return { file, title, date, decision };
}

/** Accepted DDRs added or changed since the previous freeze (all, if none). */
async function ddrsSince(repoRoot: string, previousTag: string | null): Promise<DdrSummary[]> {
  const dir = path.join(repoRoot, "decisions");
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".md") && !f.includes("template"));
  } catch {
    return [];
  }
  if (previousTag) {
    try {
      const changed = await git(repoRoot, [
        "diff",
        "--name-only",
        previousTag,
        "HEAD",
        "--",
        "decisions/",
      ]);
      const changedSet = new Set(changed.split("\n").map((f) => path.basename(f.trim())));
      files = files.filter((f) => changedSet.has(f));
    } catch {
      // previous tag missing in git (shouldn't happen) — fall back to all DDRs
    }
  }
  const summaries: DdrSummary[] = [];
  for (const file of files.sort()) {
    const parsed = parseDdr(file, await fs.readFile(path.join(dir, file), "utf8"));
    if (parsed) summaries.push(parsed);
  }
  return summaries;
}

/**
 * Glossary and user stories, from whichever layout holds them. Before this the
 * pack read only `artifacts/` — the v1 stubs `forge init` used to scaffold — so
 * a stakeholder's handoff showed "Example term — its definition." while the
 * real glossary sat unread one directory up (T-256).
 */
async function collectReference(
  repoRoot: string,
): Promise<{ glossary: string[]; userStories: string[] | null }> {
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
    return { glossary: terms, userStories: stories.length > 0 ? stories : null };
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
  };
}

export async function collectHandoffContent(
  repoRoot: string,
  inputs: HandoffInputs,
): Promise<HandoffContent> {
  const freezes = await readFreezes(repoRoot);
  const previousTag = freezes.at(-1)?.tag ?? null;
  const reference = await collectReference(repoRoot);

  return {
    projectName: path.basename(repoRoot),
    inputs,
    previousTag,
    glossary: reference.glossary,
    userStories: reference.userStories,
    ddrs: await ddrsSince(repoRoot, previousTag),
  };
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
