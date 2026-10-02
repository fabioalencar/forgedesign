import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FreezeRecord } from "../src/freezes.js";
import { generateReleaseHub } from "../src/hub.js";

let sandbox: string;

const freeze = (tag: string): FreezeRecord => ({
  tag,
  date: tag === "alpha" ? "2026-07-11" : "2026-07-12",
  commit: `${tag}-commit`,
  previewUrl: `https://preview.example/${tag}`,
  storybookUrl: `https://storybook.example/${tag}`,
  pin: "123456",
  snapshotId: null,
});

async function write(relPath: string, content: string): Promise<void> {
  const abs = path.join(sandbox, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
}

const FLOW = `---
type: Flow
id: FLOW-001
title: Getting in
date: 2026-07-01
---
Every route a visitor can reach. **The two loops are the point.**

\`\`\`mermaid
flowchart TD
  A["/ — Sign in"] -->|submit| B{Credentials match?}
  B -->|no| A
\`\`\`

- a failed sign-in returns to the same screen
- a failed password never leaves the field
`;

const DATA_MODEL = `---
type: Data Model
title: What these screens claim exists
---
Nothing here is stored.

\`\`\`mermaid
erDiagram
  ACCOUNT ||--o{ RESET_REQUEST : "requests"
\`\`\`

## Rules the screens already assume

1. **Email is the identifier.**
`;

const decision = (id: string, slug: string, front: string, decisionText = "We decided X.") =>
  write(
    `design/decisions/${id}-${slug}.md`,
    `---\ntype: Decision\nid: ${id}\ntitle: "${slug} title"\ndate: 2026-07-0${id.slice(-1)}\n${front}---\n## Decision\n\n${decisionText}\n\n## Why\n\nBecause.\n`,
  );

/** A current record with something in every section the hub renders. */
async function seedRecord(): Promise<void> {
  await write(
    "forge.json",
    JSON.stringify({ formatVersion: "0.2", recordRoot: "design" }, null, 2),
  );
  await write("design/brief.md", "---\ntype: Brief\ntitle: Brief\n---\nA useful project.\n");
  await write(
    "design/calendar.md",
    "---\ntype: Calendar\ntitle: Dates\n---\n- 2026-07-03 · checkpoint: STAKEHOLDER-001 reviews alpha\n- 2026-07-20 · deadline: decide QUESTION-001\n",
  );
  await write("design/flows/FLOW-001.md", FLOW);
  await write("design/data-model.md", DATA_MODEL);
  await write(
    "design/decisions/DDR-000-template.md",
    "---\ntype: Decision\nid: DDR-000\ntitle: Title\ndate: YYYY-MM-DD\ndecision_status: draft\n---\n## Decision\n\nOne paragraph.\n",
  );
  await decision(
    "DDR-001",
    "first",
    // Shared with stakeholders on purpose: a decision is owner-only by default (DDR-128).
    "decision_status: accepted\naudience: stakeholders\n",
    // Hard-wrapped the way the record's decisions are written.
    "Ship the **calm** message.\nEither way the answer reads the same,\nso nothing leaks.",
  );
  await decision("DDR-002", "second", "decision_status: draft\naudience: stakeholders\n");
  await decision(
    "DDR-003",
    "third",
    "decision_status: superseded\nsuperseded_by: DDR-001\naudience: stakeholders\n",
  );
  await decision(
    "DDR-004",
    "fourth",
    "decision_status: accepted\nreach: general\naudience: stakeholders\n",
  );
  // Accepted and never flipped: the creator's, and off the page.
  await decision("DDR-005", "fifth", "decision_status: accepted\n", "Pricing stays hidden.");
  await write(
    "design/glossary/account-enumeration.md",
    "---\ntype: Term\ntitle: Account enumeration\n---\nLearning whether an email has an account from how a form answers.\n",
  );
  await write(
    "design/questions/QUESTION-001.md",
    "---\ntype: Question\nid: QUESTION-001\ntitle: Keep reviewer names?\ndate: 2026-07-05\nquestion_status: open\n---\n",
  );
  await write(
    "design/feature-log.md",
    "---\ntype: Feature Log\ntitle: Feature log\ndate: 2026-07-11\ngenerated: { by: forge freeze, at: 2026-07-11T00:00:00Z }\n---\n",
  );
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(tmpdir(), "forge-hub-"));
});

afterEach(async () => {
  await fs.rm(sandbox, { recursive: true, force: true });
});

async function page(): Promise<string> {
  return fs.readFile(path.join(sandbox, "hub", "index.html"), "utf8");
}

describe("generateReleaseHub", () => {
  it("creates a first-freeze hub with the versions and the record's sections", async () => {
    await seedRecord();
    const result = await generateReleaseHub(sandbox, [freeze("alpha")]);
    const html = await page();

    expect(result?.indexPath).toBe(path.join(sandbox, "hub", "index.html"));
    expect(html).toContain("Forge · release hub");
    expect(html).toContain(">alpha<");
    expect(html).toContain("https://preview.example/alpha");
    for (const id of ["versions", "flows", "data-model", "decisions", "glossary", "timeline"]) {
      expect(html).toContain(`<section id="${id}">`);
    }
    await expect(fs.access(path.join(sandbox, "hub", "styles.css"))).resolves.toBeUndefined();
  });

  it("renders flows and the data model as Mermaid to be drawn, with the source escaped on the page", async () => {
    await seedRecord();
    await generateReleaseHub(sandbox, [freeze("alpha")]);
    const html = await page();

    // The fence becomes a block Mermaid draws from; `>` and quotes are entities,
    // which Mermaid decodes and a browser shows verbatim when it cannot draw.
    expect(html).toContain(
      '<pre class="mermaid">flowchart TD\n  A[&quot;/ — Sign in&quot;] --&gt;|submit| B{Credentials match?}',
    );
    expect(html).toContain('<pre class="mermaid">erDiagram');
    expect(html).toContain("1 flow end to end · 1 drawn");
    expect(html).toContain("mermaid@11");
    expect(html).toContain('securityLevel: "strict"');
  });

  it("renders the prose around a diagram as CommonMark rather than printing the markers", async () => {
    await seedRecord();
    await generateReleaseHub(sandbox, [freeze("alpha")]);
    const html = await page();

    expect(html).toContain("<strong>The two loops are the point.</strong>");
    expect(html).toContain("<li>a failed sign-in returns to the same screen</li>");
    expect(html).toContain("<h5>Rules the screens already assume</h5>");
    expect(html).toContain("<ol><li><strong>Email is the identifier.</strong></li></ol>");
    expect(html).not.toContain("**");
  });

  it("lists decisions the project has settled, with their one-paragraph call, and leaves drafts and the template out", async () => {
    await seedRecord();
    await generateReleaseHub(sandbox, [freeze("alpha")]);
    const html = await page();
    const decisions = html.slice(
      html.indexOf('<section id="decisions">'),
      html.indexOf('<section id="glossary">'),
    );

    expect(decisions).toContain("DDR-001");
    // The whole paragraph, not its first wrapped line.
    expect(decisions).toContain(
      "Ship the <strong>calm</strong> message. Either way the answer reads the same, so nothing leaks.",
    );
    expect(decisions).not.toContain("Because.");
    expect(decisions).toContain("superseded by DDR-001");
    expect(decisions).toContain('<span class="chip general">general</span>');
    expect(decisions).not.toContain("DDR-002");
    expect(decisions).not.toContain("DDR-000");
    // Owner-only stays owner-only, on every section of the page.
    expect(html).not.toContain("DDR-005");
    expect(html).not.toContain("Pricing stays hidden");
    expect(decisions).toContain("3 decisions shared with stakeholders");
  });

  it("renders the glossary as term and definition", async () => {
    await seedRecord();
    await generateReleaseHub(sandbox, [freeze("alpha")]);
    const html = await page();

    expect(html).toContain(
      "<dt>Account enumeration</dt><dd>Learning whether an email has an account",
    );
  });

  it("builds a timeline of every dated row — freezes, calendar rows and dated concepts — newest first", async () => {
    await seedRecord();
    await generateReleaseHub(sandbox, [freeze("alpha"), freeze("beta")]);
    const html = await page();
    const timeline = html.slice(html.indexOf('<section id="timeline">'));

    const order = [
      "2026-07-20", // deadline
      "2026-07-12", // beta
      "2026-07-11", // alpha
      "2026-07-05", // question
      "2026-07-03", // checkpoint
      "2026-07-01", // flow, decisions
    ].map((date) => timeline.indexOf(`<td class="mono">${date}</td>`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(timeline).toContain('<span class="chip freeze">freeze</span>');
    expect(timeline).toContain('<a href="https://preview.example/beta">beta frozen</a>');
    // Two freezes cut on the same day keep newest-first too.
    const sameDay = { ...freeze("beta"), tag: "beta-2" };
    await generateReleaseHub(sandbox, [freeze("alpha"), freeze("beta"), sameDay]);
    const again = (await page()).slice((await page()).indexOf('<section id="timeline">'));
    expect(again.indexOf("beta-2 frozen")).toBeLessThan(again.indexOf("beta frozen"));
    expect(timeline).toContain(
      '<span class="chip ">checkpoint</span></td><td>STAKEHOLDER-001 reviews alpha',
    );
    expect(timeline).toContain("QUESTION-001 · Keep reviewer names?");
    // A draft decision is an event too, and says so; a derived file is not.
    expect(timeline).toContain("DDR-002 · second title (draft)");
    expect(timeline).not.toContain("Feature log");
    expect(timeline).not.toContain("DDR-000");
  });

  it("is honest about what a thin record does not have, and draws nothing when there is no diagram", async () => {
    await write("forge.json", JSON.stringify({ formatVersion: "0.2", recordRoot: "design" }));
    await write("design/brief.md", "---\ntype: Brief\ntitle: Brief\n---\nA useful project.\n");
    await generateReleaseHub(sandbox, [freeze("alpha")]);
    const html = await page();

    expect(html).toContain("No flows in the record yet.");
    expect(html).toContain("No data model in the record yet.");
    expect(html).toContain("No decision has been shared with stakeholders yet.");
    expect(html).toContain("No glossary yet.");
    expect(html).toContain("1 dated row, newest first"); // the freeze
    expect(html).not.toContain("mermaid@11");
    // The v1 artifact taxonomy is gone with the surface that read it.
    expect(html).not.toContain("Journey maps");
  });

  it("replaces the hub and lists later freezes newest first", async () => {
    await seedRecord();
    await generateReleaseHub(sandbox, [freeze("alpha")]);
    await generateReleaseHub(sandbox, [freeze("alpha"), freeze("beta")]);
    const html = await page();

    expect(html.indexOf(">beta<")).toBeLessThan(html.indexOf(">alpha<"));
    expect((await fs.readdir(path.join(sandbox, "hub"))).sort()).toEqual([
      "index.html",
      "styles.css",
    ]);
  });

  it("says which screens each version changed, from the route hashes on its freeze (TASK-461)", async () => {
    await seedRecord();
    const alpha = { ...freeze("alpha"), routes: { "/": "a1", "/register": "b1" } };
    const beta = { ...freeze("beta"), routes: { "/": "a2", "/register": "b1", "/welcome": "c" } };
    await generateReleaseHub(sandbox, [alpha, beta]);
    const html = await page();
    const versions = html.slice(
      html.indexOf('<section id="versions">'),
      html.indexOf('<section id="flows">'),
    );

    expect(versions).toContain("<th>Screens</th>");
    expect(versions).toContain('<span class="chip changed">/ · changed</span>');
    expect(versions).toContain('<span class="chip new">/welcome · new</span>');
    expect(versions).not.toContain("/register ·");
    expect(versions).toContain("2 screens, all new");

    await generateReleaseHub(sandbox, [freeze("alpha"), beta]);
    const again = await page();
    expect(again).toContain("not recorded");
    expect(again).toContain("3 screens · nothing to compare with alpha");
  });

  it("does not create a hub before a project has a freeze", async () => {
    await seedRecord();
    await expect(generateReleaseHub(sandbox, [])).resolves.toBeNull();
    await expect(fs.access(path.join(sandbox, "hub", "index.html"))).rejects.toThrow();
  });
});
