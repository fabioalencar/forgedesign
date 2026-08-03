import { promises as fs } from "node:fs";
import path from "node:path";
import { ARTIFACT_TYPES } from "./artifact-types.js";
import { bundleRootOf } from "./bundle-index.js";
import type { FreezeRecord } from "./freezes.js";

const STRUCTURED_ARTIFACTS = ARTIFACT_TYPES.map(({ id, label }) => [id, label] as const);

/**
 * Which documents the hub links. One layout is served (DDR-095): a record that
 * is not current gets no document list rather than a second one, because the
 * hub linking a v0.1 file set is the hub telling a stakeholder that an
 * unmigrated record is fine to read.
 *
 * Under v0.2 the single-concept documents are named directly; the per-concept
 * directories (glossary, questions) are not linked one file at a time — the
 * bundle's own index.md is what indexes those.
 */
async function projectDocuments(
  repoRoot: string,
): Promise<ReadonlyArray<readonly [string, string]>> {
  const recordRoot = await bundleRootOf(repoRoot);
  if (recordRoot === null) return [];
  return [
    [`${recordRoot}/index.md`, "The record"],
    [`${recordRoot}/brief.md`, "Project brief"],
    [`${recordRoot}/data-model.md`, "Data model"],
    [`${recordRoot}/design-system.md`, "Design system"],
    [`${recordRoot}/calendar.md`, "Calendar"],
  ];
}

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
.eyebrow, .mono, th, .status { font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace; letter-spacing: .03em; }
.eyebrow { margin: 0 0 10px; color: var(--accent); font-size: 11px; text-transform: uppercase; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 8px; font-size: clamp(32px, 6vw, 54px); letter-spacing: -.055em; line-height: 1; }
h2 { font-size: 20px; letter-spacing: -.025em; }
h3 { margin-bottom: 4px; font-size: 15px; }
.lede { max-width: 600px; margin-bottom: 0; color: var(--muted); }
.stamp { color: var(--muted); font-size: 11px; white-space: nowrap; }
section { padding-top: 46px; }
.section-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
.section-heading p { margin-bottom: 0; color: var(--muted); font-size: 13px; }
.panel { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 15px 18px; text-align: left; border-bottom: 1px solid var(--line); }
tr:last-child td { border-bottom: 0; }
th { color: var(--muted); font-size: 10px; font-weight: 500; text-transform: uppercase; }
td { font-size: 13px; }
a { color: var(--accent); text-underline-offset: 3px; }
.links { display: flex; flex-wrap: wrap; gap: 12px; }
.status { display: inline-block; color: var(--success); font-size: 10px; text-transform: uppercase; }
.artifact-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.artifact-card { min-height: 148px; padding: 18px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.artifact-card.empty { background: transparent; }
.artifact-card p { margin-bottom: 0; color: var(--muted); font-size: 13px; }
.artifact-card ul { margin: 12px 0 0; padding-left: 18px; color: var(--muted); font-size: 12px; }
.artifact-card li + li { margin-top: 5px; }
.documents { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.document { padding: 16px 18px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
.document p { margin-bottom: 0; color: var(--muted); font-size: 12px; }
.empty-state { padding: 28px; border: 1px dashed var(--line); border-radius: var(--radius); color: var(--muted); background: var(--surface); }
footer { margin-top: 56px; color: var(--muted); font-size: 12px; }
@media (max-width: 700px) { main { width: min(100% - 28px, 1120px); padding-top: 42px; } header { align-items: start; flex-direction: column; } .artifact-grid, .documents { grid-template-columns: 1fr; } .panel { overflow-x: auto; } table { min-width: 620px; } th, td { padding: 13px 14px; } }
`;

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

function artifactStatus(text: string): string {
  const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---/);
  const source = frontmatter?.[1] ?? text;
  return source.match(/^status:\s*(.+)$/im)?.[1]?.trim() || "Recorded";
}

async function filesIn(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return filesIn(entryPath);
        return entry.isFile() ? [entryPath] : [];
      }),
    );
    return files.flat().sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function renderStructuredArtifact(
  root: string,
  slug: string,
  label: string,
): Promise<string> {
  const directory = path.join(root, "artifacts", slug);
  const files = await filesIn(directory);
  if (files.length === 0) {
    return `<article class="artifact-card empty"><h3>${escapeHtml(label)}</h3><p>No ${escapeHtml(label.toLowerCase())} yet. Add the first committed deliverable to <span class="mono">artifacts/${escapeHtml(slug)}/</span>.</p></article>`;
  }

  const items = await Promise.all(
    files.map(async (file) => {
      const text = await fs.readFile(file, "utf8").catch(() => "");
      return `<li><span class="status">${escapeHtml(artifactStatus(text))}</span> ${escapeHtml(path.relative(root, file))}</li>`;
    }),
  );
  return `<article class="artifact-card"><h3>${escapeHtml(label)}</h3><p>${files.length} committed ${files.length === 1 ? "file" : "files"}</p><ul>${items.join("")}</ul></article>`;
}

async function renderProjectDocument(root: string, file: string, label: string): Promise<string> {
  const absolutePath = path.join(root, file);
  try {
    const text = await fs.readFile(absolutePath, "utf8");
    return `<article class="document"><h3>${escapeHtml(label)}</h3><p><span class="status">${escapeHtml(artifactStatus(text))}</span> <span class="mono">${escapeHtml(file)}</span></p></article>`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return `<article class="document"><h3>${escapeHtml(label)}</h3><p>Not created yet. Add <span class="mono">${escapeHtml(file)}</span> when this project needs it.</p></article>`;
  }
}

function versionLinks(record: FreezeRecord): string {
  const links = [
    record.previewUrl
      ? `<a href="${escapeHtml(record.previewUrl)}">Preview</a>`
      : "Preview unavailable",
    record.storybookUrl
      ? `<a href="${escapeHtml(record.storybookUrl)}">Storybook</a>`
      : "Storybook unavailable",
  ];
  return `<div class="links">${links.join("")}</div>`;
}

function renderVersions(freezes: FreezeRecord[]): string {
  if (freezes.length === 0) {
    return '<div class="empty-state">No versions have been frozen yet. The first <span class="mono">forge freeze</span> will create this release index.</div>';
  }
  const rows = [...freezes]
    .reverse()
    .map(
      (record) =>
        `<tr><td class="mono">${escapeHtml(record.tag)}</td><td>${escapeHtml(record.date)}</td><td>${versionLinks(record)}</td><td><span class="status">Frozen</span></td></tr>`,
    )
    .join("");
  return `<div class="panel"><table><thead><tr><th>Version</th><th>Frozen</th><th>Links</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

export interface HubResult {
  dir: string;
  indexPath: string;
  stylesPath: string;
}

/**
 * Regenerate the committed static release hub from the release record and
 * artifact tree. An empty release list deliberately creates no hub: a hub is
 * born with a project's first freeze, and later freezes replace it wholesale.
 */
export async function generateReleaseHub(
  repoRoot: string,
  freezes: FreezeRecord[],
): Promise<HubResult | null> {
  if (freezes.length === 0) return null;

  const [artifacts, documents] = await Promise.all([
    Promise.all(
      STRUCTURED_ARTIFACTS.map(([slug, label]) => renderStructuredArtifact(repoRoot, slug, label)),
    ),
    projectDocuments(repoRoot).then((docs) =>
      Promise.all(docs.map(([file, label]) => renderProjectDocument(repoRoot, file, label))),
    ),
  ]);
  const dir = path.join(repoRoot, "hub");
  const indexPath = path.join(dir, "index.html");
  const stylesPath = path.join(dir, "styles.css");
  const generatedAt = new Date().toISOString();
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content="A Forge release index for ${escapeHtml(path.basename(repoRoot))}." />
    <title>${escapeHtml(path.basename(repoRoot))} — Forge release hub</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main>
      <header>
        <div>
          <p class="eyebrow">Forge · release hub</p>
          <h1>${escapeHtml(path.basename(repoRoot))}</h1>
          <p class="lede">A living index of frozen versions and committed design artifacts. Individual previews retain their own stakeholder PIN gate.</p>
        </div>
        <p class="stamp">Generated ${escapeHtml(generatedAt)}</p>
      </header>
      <section>
        <div class="section-heading"><h2>Versions</h2><p>${freezes.length} frozen ${freezes.length === 1 ? "version" : "versions"}</p></div>
        ${renderVersions(freezes)}
      </section>
      <section>
        <div class="section-heading"><h2>Design artifacts</h2><p>Committed project record</p></div>
        <div class="artifact-grid">${artifacts.join("")}</div>
      </section>
      <section>
        <div class="section-heading"><h2>Project documents</h2><p>One canonical file per project</p></div>
        <div class="documents">${documents.join("")}</div>
      </section>
      <footer>Generated by Forge from <span class="mono">freezes.json</span> and committed project artifacts. Publishing this directory is your team’s own static-hosting step.</footer>
    </main>
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
