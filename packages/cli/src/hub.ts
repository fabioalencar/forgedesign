// The release hub: a static index of frozen versions and the record behind
// them (TASK-460). It renders the record instead of linking to it — flows and
// the data model as diagrams, decisions with their one-paragraph call, the
// glossary, and a timeline of every dated row — because it is the OSS baseline:
// whatever a hosted window shows a stakeholder has to be reproducible here with
// Forge alone. Cloud adds identity, the PIN, comments and cross-freeze history;
// never a view the hub cannot produce.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  audienceOf,
  decisionParagraph,
  decisionReach,
  type ParsedConcept,
  parseCalendarRows,
  scanBundle,
  splitMermaid,
} from "@forgedesign/format";
import { bundleRootOf } from "./bundle-index.js";
import type { FreezeRecord } from "./freezes.js";
import { changedRoutes, compareScreens, type ScreenComparison } from "./routes.js";

/**
 * Where diagrams are drawn from. Pinned to a major so the hub does not change
 * shape under a published directory; the source stays on the page either way
 * (DDR-120).
 */
const MERMAID_MODULE = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

const TEMPLATE_DECISION_ID = "DDR-000";

const hubStyles = `:root {
  color-scheme: dark;
  --canvas: #0c0d10;
  --surface: #15171d;
  --surface-raised: #1c1f27;
  --line: #292d38;
  --text: #f0f2f7;
  --muted: #9aa2b2;
  --accent: #8e99ff;
  --success: #7dd3a8;
  --radius: 16px;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--canvas); color: var(--text); font: 15px/1.5 "Space Grotesk", "Avenir Next", sans-serif; }
main { width: min(1120px, calc(100% - 40px)); margin: 0 auto; padding: 68px 0 72px; }
header { display: flex; align-items: end; justify-content: space-between; gap: 24px; padding-bottom: 36px; border-bottom: 1px solid var(--line); }
.eyebrow, .mono, th, .status, .chip, code, pre { font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace; letter-spacing: .03em; }
.eyebrow { margin: 0 0 10px; color: var(--accent); font-size: 11px; text-transform: uppercase; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 8px; font-size: clamp(32px, 6vw, 54px); letter-spacing: -.055em; line-height: 1; }
h2 { font-size: 20px; letter-spacing: -.025em; }
h3 { margin-bottom: 4px; font-size: 17px; letter-spacing: -.02em; }
.lede { max-width: 600px; margin-bottom: 0; color: var(--muted); }
.stamp { color: var(--muted); font-size: 11px; white-space: nowrap; }
nav.sections { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
nav.sections a { padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 12px; text-decoration: none; }
nav.sections a:hover { color: var(--text); border-color: var(--muted); }
section { padding-top: 46px; }
.section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.section-heading p { margin-bottom: 0; color: var(--muted); font-size: 13px; }
.panel { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 15px 18px; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
tr:last-child td { border-bottom: 0; }
th { color: var(--muted); font-size: 10px; font-weight: 500; text-transform: uppercase; }
td { font-size: 13px; }
a { color: var(--accent); text-underline-offset: 3px; }
.links { display: flex; flex-wrap: wrap; gap: 12px; }
.status { display: inline-block; color: var(--success); font-size: 10px; text-transform: uppercase; }
.chip { display: inline-block; padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); font-size: 10px; text-transform: uppercase; white-space: nowrap; }
.chip.freeze { color: var(--success); }
.chip.general { color: var(--accent); }
.chip.new { color: var(--success); }
.chip.changed { color: var(--accent); }
.chip.removed { text-decoration: line-through; }
.screens { display: flex; flex-wrap: wrap; gap: 6px; }
.muted { color: var(--muted); }
.card { padding: 22px 24px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.card + .card { margin-top: 12px; }
.card .eyebrow { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
.prose { color: var(--muted); font-size: 14px; }
.prose p, .prose ul, .prose ol, .prose blockquote, .prose pre { margin: 0 0 10px; }
.prose ul, .prose ol { padding-left: 20px; }
.prose h4, .prose h5 { margin: 14px 0 6px; color: var(--text); font-size: 13px; }
.prose strong { color: var(--text); }
.prose code { font-size: 12px; color: var(--text); }
.prose blockquote { padding-left: 14px; border-left: 2px solid var(--line); }
.prose pre { overflow-x: auto; padding: 12px 14px; border-radius: 10px; background: var(--surface-raised); font-size: 12px; }
.prose > :last-child { margin-bottom: 0; }
pre.mermaid { margin: 14px 0 0; padding: 16px; overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--surface-raised); color: var(--muted); font-size: 12px; line-height: 1.45; white-space: pre; }
pre.mermaid[data-processed] { color: var(--text); white-space: normal; text-align: center; }
pre.mermaid svg { max-width: 100%; height: auto; }
dl.glossary { display: grid; grid-template-columns: minmax(160px, 240px) 1fr; gap: 12px 20px; margin: 0; }
dl.glossary dt { font-weight: 600; }
dl.glossary dd { margin: 0; color: var(--muted); font-size: 14px; }
.timeline td:first-child { white-space: nowrap; }
.timeline td:nth-child(2) { width: 1%; }
.empty-state { padding: 28px; border: 1px dashed var(--line); border-radius: var(--radius); color: var(--muted); background: var(--surface); }
footer { margin-top: 56px; color: var(--muted); font-size: 12px; }
@media (max-width: 700px) { main { width: min(100% - 28px, 1120px); padding-top: 42px; } header { align-items: start; flex-direction: column; } .panel { overflow-x: auto; } table { min-width: 620px; } th, td { padding: 13px 14px; } dl.glossary { grid-template-columns: 1fr; gap: 4px 0; } dl.glossary dd { margin-bottom: 10px; } }
`;

// --- html helpers -----------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}

/**
 * Inline CommonMark the record actually uses — code spans, emphasis, links —
 * over already-escaped text. The record is plain CommonMark (spec §1 principle
 * 5), and printing `**like this**` on a page is the defect the dashboard
 * already fixed once (TASK-392); a static page owes its reader the same.
 */
function renderInline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * Block-level CommonMark for a concept body: headings, lists, quotes, fenced
 * code, paragraphs. A projection for reading, not a Markdown engine — the
 * record's bodies are prose around a diagram, and this is what they contain.
 */
function renderMarkdown(body: string): string {
  const out: string[] = [];
  const lines = body.split("\n");
  let index = 0;

  const isBlank = (line: string | undefined) => line === undefined || line.trim() === "";

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // closing fence, if any
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading?.[1] && heading[2]) {
      // A concept body's `##` sits under the page's own h2/h3, so it renders
      // two levels down and never outranks the section it is in.
      const level = Math.min(heading[1].length + 3, 6);
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    const bullet = /^\s*[-*]\s+(.*)$/;
    if (bullet.test(line)) {
      const items: string[] = [];
      while (index < lines.length && bullet.test(lines[index] ?? "")) {
        items.push(`<li>${renderInline(bullet.exec(lines[index] ?? "")?.[1] ?? "")}</li>`);
        index += 1;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/;
    if (numbered.test(line)) {
      const items: string[] = [];
      while (index < lines.length && numbered.test(lines[index] ?? "")) {
        items.push(`<li>${renderInline(numbered.exec(lines[index] ?? "")?.[1] ?? "")}</li>`);
        index += 1;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^\s*>\s?/, ""));
        index += 1;
      }
      out.push(`<blockquote><p>${renderInline(quoted.join(" "))}</p></blockquote>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && !isBlank(lines[index])) {
      const next = lines[index] ?? "";
      if (/^\s*```/.test(next) || /^#{1,6}\s/.test(next)) break;
      paragraph.push(next.trim());
      index += 1;
    }
    out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }

  return out.join("");
}

// --- the record, read once ----------------------------------------------------

interface TimelineRow {
  date: string;
  /** what kind of row: a calendar row's own word, `freeze`, or the concept type */
  kind: string;
  text: string;
  href: string | null;
}

interface HubRecord {
  present: boolean;
  recordRoot: string | null;
  flows: ParsedConcept[];
  dataModel: ParsedConcept | null;
  /** decisions that were made — accepted or since superseded; drafts are proposals */
  decisions: ParsedConcept[];
  terms: ParsedConcept[];
  /** every dated row in the record and the freeze registry, newest first */
  timeline: TimelineRow[];
}

const byId = (a: ParsedConcept, b: ParsedConcept) => (a.id ?? "").localeCompare(b.id ?? "");
const byTitle = (a: ParsedConcept, b: ParsedConcept) =>
  (a.title ?? a.relPath).localeCompare(b.title ?? b.relPath);

function isTemplate(concept: ParsedConcept): boolean {
  return concept.id === TEMPLATE_DECISION_ID;
}

function decisionStatus(concept: ParsedConcept): string {
  return concept.domainStatus?.value ?? "";
}

async function readRecord(repoRoot: string, freezes: FreezeRecord[]): Promise<HubRecord> {
  const recordRoot = await bundleRootOf(repoRoot);
  const empty: HubRecord = {
    present: false,
    recordRoot,
    flows: [],
    dataModel: null,
    decisions: [],
    terms: [],
    timeline: [],
  };
  if (recordRoot === null) return empty;

  const bundle = await scanBundle(repoRoot, { recordRoot });
  if (!bundle.present) return empty;
  // The hub is what the creator publishes to stakeholders, so it shows what
  // stakeholders may see and nothing else (DDR-128): a decision stays off the
  // page until its `audience` says otherwise, and feedback never appears.
  const concepts = bundle.concepts.filter(
    (concept) => !isTemplate(concept) && audienceOf(concept) === "stakeholders",
  );

  const timeline: TimelineRow[] = [];
  // Newest first, so two freezes cut on the same day keep that order under
  // the stable sort below.
  for (const freeze of [...freezes].reverse()) {
    timeline.push({
      date: freeze.date,
      kind: "freeze",
      text: `${freeze.tag} frozen`,
      href: freeze.previewUrl,
    });
  }
  const calendar = concepts.find((concept) => concept.type === "Calendar");
  if (calendar) {
    for (const row of parseCalendarRows(calendar.body)) {
      timeline.push({
        date: row.date,
        kind: row.kind ?? "calendar",
        text: row.kind ? row.text.slice(row.kind.length + 1).trim() : row.text,
        href: null,
      });
    }
  }
  for (const concept of concepts) {
    // A dated concept is an event in the project's life; a derived file is not,
    // and a ledger's rows are dated by `opened`, which the feature log already
    // turns into "what closed per freeze".
    if (!concept.date || concept.generated !== null || !concept.type) continue;
    if (concept.type === "Task Ledger" || concept.type === "Calendar") continue;
    const status =
      concept.type === "Decision" && decisionStatus(concept) !== "accepted"
        ? ` (${decisionStatus(concept)})`
        : "";
    timeline.push({
      date: concept.date,
      kind: concept.type.toLowerCase(),
      text: `${concept.id ? `${concept.id} · ` : ""}${concept.title ?? concept.relPath}${status}`,
      href: null,
    });
  }
  timeline.sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind));

  return {
    present: true,
    recordRoot,
    flows: concepts.filter((concept) => concept.type === "Flow").sort(byId),
    dataModel: concepts.find((concept) => concept.type === "Data Model") ?? null,
    decisions: concepts
      .filter(
        (concept) =>
          concept.type === "Decision" &&
          ["accepted", "superseded"].includes(decisionStatus(concept)),
      )
      .sort(byId),
    terms: concepts.filter((concept) => concept.type === "Term").sort(byTitle),
    timeline,
  };
}

// --- sections -------------------------------------------------------------------

function versionLinks(record: FreezeRecord): string {
  const links = [
    record.previewUrl
      ? `<a href="${escapeHtml(record.previewUrl)}">Preview</a>`
      : "<span>Preview unavailable</span>",
    record.storybookUrl
      ? `<a href="${escapeHtml(record.storybookUrl)}">Storybook</a>`
      : "<span>Storybook unavailable</span>",
  ];
  return `<div class="links">${links.join("")}</div>`;
}

/** Which screens a version changed, from the route hashes on its freeze (TASK-461). */
function renderScreens(comparison: ScreenComparison): string {
  switch (comparison.kind) {
    case "unrecorded":
      return '<span class="muted">not recorded</span>';
    case "baseline-unrecorded":
      return `<span class="muted">${count(comparison.routes.length, "screen")} · nothing to compare with ${escapeHtml(comparison.previousTag)}</span>`;
    case "first":
      return `<span class="muted">${count(comparison.screens.length, "screen")}, all new</span>`;
    case "compared": {
      const moved = changedRoutes(comparison);
      if (moved.length === 0) {
        return `<span class="muted">no screen changed since ${escapeHtml(comparison.previousTag)}</span>`;
      }
      return `<div class="screens">${moved
        .map(
          (screen) =>
            `<span class="chip ${screen.status}">${escapeHtml(screen.route)} · ${screen.status}</span>`,
        )
        .join("")}</div>`;
    }
  }
}

function renderVersions(freezes: FreezeRecord[]): string {
  const rows = freezes
    .map((record, index) => {
      const screens = renderScreens(compareScreens(record, freezes[index - 1] ?? null));
      return `<tr><td class="mono">${escapeHtml(record.tag)}</td><td>${escapeHtml(record.date)}</td><td>${screens}</td><td>${versionLinks(record)}</td><td><span class="status">Frozen</span></td></tr>`;
    })
    .reverse()
    .join("");
  return `<div class="panel"><table><thead><tr><th>Version</th><th>Frozen</th><th>Screens</th><th>Links</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function renderDiagrams(diagrams: string[]): string {
  return diagrams.map((source) => `<pre class="mermaid">${escapeHtml(source)}</pre>`).join("");
}

function renderFlows(record: HubRecord): string {
  if (record.flows.length === 0) {
    return `<div class="empty-state">No flows in the record yet. Add one under <span class="mono">${escapeHtml(record.recordRoot ?? "design")}/flows/</span> when a path crosses more screens than one person can hold in their head — the body is a Mermaid flowchart, and it draws here.</div>`;
  }
  return record.flows
    .map((flow) => {
      const { diagrams, prose } = splitMermaid(flow.body);
      const drawn =
        diagrams.length === 0
          ? '<p class="prose">No diagram in this one yet — a flow that is only prose is a flow nobody can check at a glance.</p>'
          : renderDiagrams(diagrams);
      return `<article class="card"><p class="eyebrow">${escapeHtml(flow.id ?? "")}${flow.date ? `<span class="chip">${escapeHtml(flow.date)}</span>` : ""}</p><h3>${escapeHtml(flow.title ?? flow.relPath)}</h3>${prose ? `<div class="prose">${renderMarkdown(prose)}</div>` : ""}${drawn}</article>`;
    })
    .join("");
}

function renderDataModel(record: HubRecord): string {
  const model = record.dataModel;
  if (model === null) {
    return `<div class="empty-state">No data model in the record yet. <span class="mono">${escapeHtml(record.recordRoot ?? "design")}/data-model.md</span> appears when the prototype's data shape is worth recording — what the data <em>is</em>, drawn as an entity diagram.</div>`;
  }
  const { diagrams, prose } = splitMermaid(model.body);
  return `<article class="card"><h3>${escapeHtml(model.title ?? "Data model")}</h3>${renderDiagrams(diagrams)}${prose ? `<div class="prose">${renderMarkdown(prose)}</div>` : ""}</article>`;
}

/** The `## Decision` section of a decision body — the one paragraph a reader wants first. */
function renderDecisions(record: HubRecord): string {
  if (record.decisions.length === 0) {
    return '<div class="empty-state">No decision has been shared with stakeholders yet. A decision stays with the creator by default, because it carries the alternatives it beat; one whose why is a stakeholder\'s to read gets <span class="mono">audience: stakeholders</span> and lands here once accepted.</div>';
  }
  return record.decisions
    .map((decision) => {
      const status = decisionStatus(decision);
      const supersededBy =
        typeof decision.frontmatter.superseded_by === "string"
          ? decision.frontmatter.superseded_by
          : null;
      const chips = [
        decision.date ? `<span class="chip">${escapeHtml(decision.date)}</span>` : "",
        status === "superseded"
          ? `<span class="chip">superseded${supersededBy ? ` by ${escapeHtml(supersededBy)}` : ""}</span>`
          : "",
        decisionReach(decision) === "general" ? '<span class="chip general">general</span>' : "",
      ].join("");
      const paragraph = decisionParagraph(decision.body);
      return `<article class="card"><p class="eyebrow">${escapeHtml(decision.id ?? "")}${chips}</p><h3>${escapeHtml(decision.title ?? decision.relPath)}</h3>${paragraph ? `<div class="prose">${renderMarkdown(paragraph)}</div>` : ""}</article>`;
    })
    .join("");
}

function renderGlossary(record: HubRecord): string {
  if (record.terms.length === 0) {
    return '<div class="empty-state">No glossary yet. A term earns a file when it carries project meaning a newcomer would otherwise have to ask about.</div>';
  }
  const entries = record.terms
    .map((term) => {
      const definition = term.description ?? term.body.trim().split("\n")[0] ?? "";
      return `<dt>${escapeHtml(term.title ?? term.relPath)}</dt><dd>${renderInline(definition)}</dd>`;
    })
    .join("");
  return `<div class="card"><dl class="glossary">${entries}</dl></div>`;
}

function renderTimeline(record: HubRecord): string {
  if (record.timeline.length === 0) {
    return '<div class="empty-state">Nothing dated yet. Freezes, calendar rows and dated concepts all land here as they happen.</div>';
  }
  const rows = record.timeline
    .map((row) => {
      const text = row.href
        ? `<a href="${escapeHtml(row.href)}">${renderInline(row.text)}</a>`
        : renderInline(row.text);
      return `<tr><td class="mono">${escapeHtml(row.date)}</td><td><span class="chip ${row.kind === "freeze" ? "freeze" : ""}">${escapeHtml(row.kind)}</span></td><td>${text}</td></tr>`;
    })
    .join("");
  return `<div class="panel timeline"><table><thead><tr><th>Date</th><th>What</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** Drawn in the browser from the source on the page; without it, the source stays (DDR-120). */
function mermaidScript(): string {
  return `<script type="module">
      try {
        const { default: mermaid } = await import(${JSON.stringify(MERMAID_MODULE)});
        mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", suppressErrorRendering: true, flowchart: { useMaxWidth: true }, er: { useMaxWidth: true } });
        await mermaid.run({ querySelector: "pre.mermaid" });
      } catch {
        // Offline or blocked: the Mermaid source stays readable, which is what the record holds.
      }
    </script>`;
}

export interface HubResult {
  dir: string;
  indexPath: string;
  stylesPath: string;
}

/**
 * Regenerate the committed static release hub from the freeze registry and
 * the record. An empty release list deliberately creates no hub: a hub is born
 * with a project's first freeze, and later freezes replace it wholesale.
 */
export async function generateReleaseHub(
  repoRoot: string,
  freezes: FreezeRecord[],
): Promise<HubResult | null> {
  if (freezes.length === 0) return null;

  const record = await readRecord(repoRoot, freezes);
  const projectName = path.basename(repoRoot);
  const dir = path.join(repoRoot, "hub");
  const indexPath = path.join(dir, "index.html");
  const stylesPath = path.join(dir, "styles.css");
  const generatedAt = new Date().toISOString();

  const drawnFlows = record.flows.filter((flow) => splitMermaid(flow.body).diagrams.length > 0);
  const modelDiagrams = record.dataModel ? splitMermaid(record.dataModel.body).diagrams.length : 0;
  const hasDiagrams = drawnFlows.length > 0 || modelDiagrams > 0;

  const sections = [
    ["versions", "Versions"],
    ["flows", "Flows"],
    ["data-model", "Data model"],
    ["decisions", "Decisions"],
    ["glossary", "Glossary"],
    ["timeline", "Timeline"],
  ] as const;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="A Forge release hub for ${escapeHtml(projectName)}: frozen versions and the design record behind them." />
    <title>${escapeHtml(projectName)} — Forge release hub</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <header>
        <div>
          <p class="eyebrow">Forge · release hub</p>
          <h1>${escapeHtml(projectName)}</h1>
          <p class="lede">The frozen versions and the record behind them — flows, the data model, what was decided, the words the project uses, and when things happened. Hosted reviews keep their own PIN gate.</p>
          <nav class="sections">${sections.map(([id, label]) => `<a href="#${id}">${label}</a>`).join("")}</nav>
        </div>
        <p class="stamp">Generated ${escapeHtml(generatedAt)}</p>
      </header>
      <section id="versions">
        <div class="section-heading"><h2>Versions</h2><p>${count(freezes.length, "frozen version")}</p></div>
        ${renderVersions(freezes)}
      </section>
      <section id="flows">
        <div class="section-heading"><h2>Flows</h2><p>${record.flows.length > 0 ? `${count(record.flows.length, "flow")} end to end · ${drawnFlows.length} drawn` : "How work moves through the product, end to end"}</p></div>
        ${renderFlows(record)}
      </section>
      <section id="data-model">
        <div class="section-heading"><h2>Data model</h2><p>${record.dataModel ? "What the screens claim exists" : "What the data is, not how to serve it"}</p></div>
        ${renderDataModel(record)}
      </section>
      <section id="decisions">
        <div class="section-heading"><h2>Decisions</h2><p>${record.decisions.length > 0 ? `${count(record.decisions.length, "decision")} shared with stakeholders` : "What the project has settled, and why"}</p></div>
        ${renderDecisions(record)}
      </section>
      <section id="glossary">
        <div class="section-heading"><h2>Glossary</h2><p>${record.terms.length > 0 ? count(record.terms.length, "term") : "The words this project uses"}</p></div>
        ${renderGlossary(record)}
      </section>
      <section id="timeline">
        <div class="section-heading"><h2>Timeline</h2><p>${record.timeline.length > 0 ? `${count(record.timeline.length, "dated row")}, newest first` : "Every dated row in the record"}</p></div>
        ${renderTimeline(record)}
      </section>
      <footer>Generated by Forge from <span class="mono">freezes.json</span> and the design record${record.recordRoot ? ` in <span class="mono">${escapeHtml(record.recordRoot)}/</span>` : ""}. Diagrams draw in the browser from the Mermaid the record holds; without a network the source stays readable. Publishing this directory is your team’s own static-hosting step.</footer>
    </main>
    ${hasDiagrams ? mermaidScript() : ""}
  </body>
</html>
`;

  await fs.mkdir(dir, { recursive: true });
  await Promise.all([
    fs.writeFile(indexPath, html, "utf8"),
    fs.writeFile(stylesPath, hubStyles, "utf8"),
  ]);
  return { dir, indexPath, stylesPath };
}
