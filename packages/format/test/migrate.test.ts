import { describe, expect, it } from "vitest";
import { parseConcept } from "../src/concepts.js";
import { parseFrontmatter } from "../src/frontmatter.js";
import { type MigrationPlan, planMigrationToV02, type V01Sources } from "../src/migrate.js";

const fileAt = (plan: MigrationPlan, relPath: string): string => {
  const file = plan.files.find((f) => f.relPath === relPath);
  if (!file)
    throw new Error(
      `no migrated file at ${relPath}; got: ${plan.files.map((f) => f.relPath).join(", ")}`,
    );
  return file.text;
};

const frontmatterAt = (plan: MigrationPlan, relPath: string): Record<string, unknown> => {
  const parsed = parseFrontmatter(fileAt(plan, relPath));
  if (parsed.kind !== "ok")
    throw new Error(`frontmatter at ${relPath} did not parse: ${parsed.kind}`);
  return parsed.data;
};

describe("planMigrationToV02", () => {
  it("moves whole-file concepts into the bundle with their type", () => {
    const plan = planMigrationToV02({ brief: "# The brief\n\nWhat we are building.\n" });
    expect(frontmatterAt(plan, "design/brief.md")).toMatchObject({
      type: "Brief",
      title: "The brief",
    });
    expect(fileAt(plan, "design/brief.md")).toContain("What we are building.");
    expect(plan.supersededSources).toContain("Brief.md");
  });

  it("keeps Todos.md a single ledger rather than atomizing tasks (DDR-060)", () => {
    const todos = "# Todos\n\n## Doing\n- [ ] TASK-001 Ship it\n  status: doing\n";
    const plan = planMigrationToV02({ todos });
    expect(frontmatterAt(plan, "design/todos.md")).toMatchObject({ type: "Task Ledger" });
    expect(fileAt(plan, "design/todos.md")).toContain("- [ ] TASK-001 Ship it");
    expect(plan.files.filter((f) => f.relPath.includes("TASK-001.md"))).toHaveLength(0);
  });

  it("splits feedback rows into concepts, mapping status and its link", () => {
    const feedbacks = [
      "# Feedbacks",
      "",
      "- FEEDBACK-011 — 2026-07-18 · source: meeting · from: STAKEHOLDER-002",
      '  quote: "The enterprise column reads like an afterthought."',
      "  status: accepted → TASK-042",
      "",
    ].join("\n");

    const plan = planMigrationToV02({ feedbacks });

    expect(frontmatterAt(plan, "design/feedback/FEEDBACK-011.md")).toEqual({
      type: "Feedback",
      id: "FEEDBACK-011",
      title: "The enterprise column reads like an afterthought.",
      date: "2026-07-18",
      feedback_status: "accepted",
      source: "meeting",
      from: "STAKEHOLDER-002",
      resolution: "TASK-042",
    });
    expect(fileAt(plan, "design/feedback/FEEDBACK-011.md")).toContain(
      "> The enterprise column reads like an afterthought.",
    );
  });

  it("splits questions, taking the prose line as the title and notes into the body", () => {
    const openQuestions = [
      "# Open questions",
      "",
      "- QUESTION-001 — 2026-05-03 · status: open",
      "  Is the skip-quiz button used too often?",
      "  context: Brief.md, TASK-015",
      "  notes: If yes, cut the recap quiz to 2-3 questions.",
      "",
    ].join("\n");

    const plan = planMigrationToV02({ openQuestions });
    const text = fileAt(plan, "design/questions/QUESTION-001.md");

    expect(frontmatterAt(plan, "design/questions/QUESTION-001.md")).toMatchObject({
      type: "Question",
      id: "QUESTION-001",
      title: "Is the skip-quiz button used too often?",
      question_status: "open",
      context: "Brief.md, TASK-015",
    });
    expect(text).toContain("If yes, cut the recap quiz to 2-3 questions.");
  });

  it("carries a question's resolution link", () => {
    const plan = planMigrationToV02({
      openQuestions: "- QUESTION-002 — 2026-07-12 · status: resolved → DDR-047\n  Should we?\n",
    });
    expect(frontmatterAt(plan, "design/questions/QUESTION-002.md")).toMatchObject({
      question_status: "resolved",
      resolution: "DDR-047",
    });
  });

  it("splits identity-style ledgers into per-concept files", () => {
    const plan = planMigrationToV02({
      userRoles: "# Roles\n\n- ROLE-001 — Returning customer\n  can: browse, reorder\n",
      stakeholders: "- STAKEHOLDER-002 — Ana, ops lead\n",
    });
    expect(frontmatterAt(plan, "design/roles/ROLE-001.md")).toMatchObject({
      type: "Role",
      id: "ROLE-001",
      title: "Returning customer",
      can: "browse, reorder",
    });
    expect(frontmatterAt(plan, "design/stakeholders/STAKEHOLDER-002.md")).toMatchObject({
      type: "Stakeholder",
      id: "STAKEHOLDER-002",
      title: "Ana, ops lead",
    });
  });

  it("gives each glossary term its own file, slugged from the term", () => {
    const glossary = [
      "# Glossary",
      "",
      "Terms used consistently. One line each.",
      "",
      "- **Root topic** — what the learner typed to begin a path.",
      "- **Picker** — the step that turns a topic into a video.",
      "",
    ].join("\n");

    const plan = planMigrationToV02({ glossary });

    expect(frontmatterAt(plan, "design/glossary/root-topic.md")).toMatchObject({
      type: "Term",
      title: "Root topic",
    });
    expect(fileAt(plan, "design/glossary/picker.md")).toContain(
      "the step that turns a topic into a video.",
    );
  });

  it("reports a glossary line it cannot read instead of dropping it", () => {
    const plan = planMigrationToV02({ glossary: "# Glossary\n\n- a bullet with no bolded term\n" });
    expect(plan.warnings.join()).toMatch(/could not read a term/);
    expect(plan.supersededSources).not.toContain("Glossary.md");
  });

  it("turns a decision's header block into frontmatter and drops it from the body", () => {
    const text = [
      "# DDR-001 — Default to Gemini Flash Lite",
      "",
      "- **Status**: superseded (by DDR-009)",
      "- **Date**: 2026-07-24",
      "- **Context source**: a model comparison run",
      "",
      "## Decision",
      "",
      "Use the cheap model.",
      "",
    ].join("\n");

    const plan = planMigrationToV02({ decisions: [{ filename: "DDR-001-flash-lite.md", text }] });
    const migrated = fileAt(plan, "design/decisions/DDR-001-flash-lite.md");

    expect(frontmatterAt(plan, "design/decisions/DDR-001-flash-lite.md")).toMatchObject({
      type: "Decision",
      id: "DDR-001",
      title: "Default to Gemini Flash Lite",
      date: "2026-07-24",
      decision_status: "superseded",
      superseded_by: "DDR-009",
      context_source: "a model comparison run",
    });
    expect(migrated).toContain("## Decision");
    expect(migrated).not.toContain("- **Status**");
    expect(migrated).not.toContain("# DDR-001 —");
  });

  it("keeps an accepted decision accepted when its status carries a qualifier", () => {
    const text = [
      "# DDR-060 — OKF profile decisions",
      "",
      "- **Status**: accepted · refines DDR-055 and DDR-059",
      "",
      "## Decision",
      "",
      "Keep OKF status pure.",
      "",
    ].join("\n");

    const plan = planMigrationToV02({ decisions: [{ filename: "DDR-060-okf-profile.md", text }] });
    expect(frontmatterAt(plan, "design/decisions/DDR-060-okf-profile.md")).toMatchObject({
      decision_status: "accepted",
      // the qualifier is authored prose; the Status block leaves the body, so
      // dropping it here would delete the sentence explaining the nuance
      description: "refines DDR-055 and DDR-059",
    });
    expect(plan.warnings).toEqual([]);
  });

  it("migrates the DDR-000 template as a draft without complaining about its enum listing", () => {
    const text = [
      "# DDR-000 — Title",
      "",
      "- **Status**: draft | accepted | superseded (by DDR-###)",
      "- **Date**: YYYY-MM-DD",
      "",
      "## Decision",
      "",
    ].join("\n");
    const plan = planMigrationToV02({ decisions: [{ filename: "DDR-000-template.md", text }] });
    expect(frontmatterAt(plan, "design/decisions/DDR-000-template.md")).toMatchObject({
      id: "DDR-000",
      decision_status: "draft",
    });
    expect(plan.warnings).toEqual([]);
  });

  it("moves FeatureLog's generation marker into `generated` frontmatter", () => {
    const featureLog = [
      "<!-- generated by forge freeze · FREEZE-004 · do not edit -->",
      "",
      "# Feature log",
      "",
      "- Shipped the pricing table.",
      "",
    ].join("\n");

    const plan = planMigrationToV02({ featureLog });
    const migrated = fileAt(plan, "design/feature-log.md");

    expect(frontmatterAt(plan, "design/feature-log.md")).toMatchObject({
      type: "Feature Log",
      generated: { by: "forge freeze" },
      freeze: "FREEZE-004",
    });
    expect(migrated).not.toContain("<!-- generated by");
    expect(migrated).toContain("Shipped the pricing table.");
  });

  it("writes a bundle-root index declaring the OKF version", () => {
    const plan = planMigrationToV02({ brief: "# Brief\n" });
    const index = fileAt(plan, "design/index.md");
    expect(index.startsWith('---\nokf_version: "0.2"\n---\n')).toBe(true);
    // Entries link by the concept's title, through the same builder `forge
    // index` uses — so a migrated index is byte-identical to a regenerated one.
    expect(index).toContain("[Brief](brief.md)");
  });

  it("honors a configured record root", () => {
    const plan = planMigrationToV02({ brief: "# Brief\n" }, { recordRoot: "knowledge" });
    expect(plan.files.every((f) => f.relPath.startsWith("knowledge/"))).toBe(true);
  });
});

describe("the migrated bundle is valid v0.2", () => {
  // The strongest check available without doctor: every file the migration
  // emits must parse as a conformant concept, by the same parser the CLI, the
  // renderer, and doctor will use.
  it("emits concepts with no problems, from a record using every v0.1 shape", () => {
    const sources: V01Sources = {
      brief: "# Brief\n\nGenesis.\n",
      todos: "# Todos\n\n## Todo\n- [ ] TASK-001 Do it\n  status: todo\n",
      glossary: "# Glossary\n\n- **Path** — one learner's journey.\n",
      openQuestions: "- QUESTION-001 — 2026-05-03 · status: open\n  Is it used?\n",
      feedbacks:
        '- FEEDBACK-001 — 2026-07-18 · source: review · from: Ana\n  quote: "Too small."\n  status: pending\n',
      stakeholders: "- STAKEHOLDER-001 — Ana, ops lead\n",
      userStories: "- STORY-001 — As a learner I want to resume.\n",
      userRoles: "- ROLE-001 — Returning learner\n",
      processFlows: "- FLOW-001 — Signup to first video\n",
      dataModel: "# Data model\n\n## Path\n",
      calendar: "# Calendar\n\n- 2026-08-01 · checkpoint: review\n",
      design: "# Design\n\nInk on paper.\n",
      components: "# Components\n\n- Button\n",
      featureLog: "<!-- generated by forge freeze · FREEZE-001 · do not edit -->\n\n- Shipped.\n",
      decisions: [
        {
          filename: "DDR-001-first.md",
          text: "# DDR-001 — First\n\n- **Status**: accepted\n- **Date**: 2026-05-03\n\n## Decision\n\nYes.\n",
        },
      ],
    };

    const plan = planMigrationToV02(sources);

    expect(plan.warnings).toEqual([]);
    const problems = plan.files
      .filter((file) => !file.relPath.endsWith("/index.md"))
      .flatMap((file) => {
        const relPath = file.relPath.slice("design/".length);
        return parseConcept(relPath, file.text).problems.map(
          (p) => `${relPath}: ${p.kind} — ${p.message}`,
        );
      });
    expect(problems).toEqual([]);
  });

  it("produces nothing at all from an empty record", () => {
    // Not even an index: a directory with no v0.1 sources is not a record, and
    // upgrade must not fabricate a project in one.
    const plan = planMigrationToV02({});
    expect(plan.files).toEqual([]);
    expect(plan.supersededSources).toEqual([]);
  });
});
