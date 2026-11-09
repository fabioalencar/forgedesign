// Context intake (DDR-021, reshaped per DDR-050): raw material is staged,
// classified by the designer's own agent session (the `forge-intake` skill), then
// validated here before a human accepts an individual proposal into the
// tracked design record. The CLI never dispatches a model.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { localIsoDate } from "./freezes.js";
import { openTaskLedger } from "./task-ledger.js";

/**
 * What a classified item may become (TASK-305, DDR-156): a task in the ledger,
 * or a decision staged for `forge ddr apply`. There was a third, `artifact`,
 * which wrote `artifacts/<type>/` — a surface the format dropped and nothing
 * reads — so a deliverable someone asked for is a task now.
 */
export type IntakeItemType = "task" | "ddr";

export interface IntakeWarning {
  code: "short" | "timeline-gap" | "no-timestamps";
  message: string;
}

export interface IntakeProposalItem {
  type: IntakeItemType;
  title: string;
  quote: string;
  notes?: string;
  acceptedTarget?: string;
}

interface IntakeMeta {
  id: string;
  createdAt: string;
  sourceName: string;
  sourceFile: string;
  prompt: string;
  warnings: IntakeWarning[];
}

interface IntakeProposal {
  items: IntakeProposalItem[];
}

export interface StagedIntake {
  id: string;
  sourceName: string;
  warnings: IntakeWarning[];
  needsConfirmation: boolean;
}

const SHORT_TRANSCRIPT_WORDS = 80;
const TIMELINE_GAP_SECONDS = 5 * 60;
const intakeRoot = (repoRoot: string) => path.join(repoRoot, ".forge", "intake");
const stageDir = (repoRoot: string, id: string) => path.join(intakeRoot(repoRoot), id);
const safeFileName = (name: string) =>
  path.basename(name).replace(/[^A-Za-z0-9._-]/g, "-") || "context.txt";

function textWords(text: string): number {
  return text.trim().match(/\S+/g)?.length ?? 0;
}

function timestampSeconds(text: string): number[] {
  const out: number[] = [];
  // VTT/SRT timestamps and common plain transcript forms such as [01:02:03].
  const re = /(?:\[|\b)(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?(?:\]|\b)/g;
  for (const match of text.matchAll(re)) {
    const hours = Number(match[1] ?? 0);
    const minutes = Number(match[2]);
    const seconds = Number(match[3]);
    const millis = Number((match[4] ?? "0").padEnd(3, "0"));
    if (minutes < 60 && seconds < 60)
      out.push(hours * 3600 + minutes * 60 + seconds + millis / 1000);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** The deliberately visible, confirm-don't-block quality gate from DDR-021. */
export function intakeWarnings(source: string): IntakeWarning[] {
  const warnings: IntakeWarning[] = [];
  const words = textWords(source);
  if (words < SHORT_TRANSCRIPT_WORDS) {
    warnings.push({
      code: "short",
      message: `Only ${words} words detected (the intake check expects at least ${SHORT_TRANSCRIPT_WORDS}).`,
    });
  }
  const timestamps = timestampSeconds(source);
  if (timestamps.length === 0) {
    warnings.push({
      code: "no-timestamps",
      message: "No timestamps detected; completeness is unverifiable.",
    });
  } else {
    const gap = timestamps
      .slice(1)
      .find((at, index) => at - (timestamps[index] ?? at) > TIMELINE_GAP_SECONDS);
    if (gap !== undefined) {
      warnings.push({
        code: "timeline-gap",
        message: `A timeline gap larger than ${TIMELINE_GAP_SECONDS / 60} minutes was detected; a segment may be missing.`,
      });
    }
  }
  return warnings;
}

/** Stage an uploaded source only. This must not touch tracked project files. */
export async function stageIntake(options: {
  cwd?: string;
  sourceName: string;
  source: string;
  prompt?: string;
}): Promise<StagedIntake> {
  const root = path.resolve(options.cwd ?? process.cwd());
  const id = randomUUID();
  const sourceName = safeFileName(options.sourceName);
  const dir = stageDir(root, id);
  const sourceFile = `source-${sourceName}`;
  const warnings = intakeWarnings(options.source);
  const meta: IntakeMeta = {
    id,
    createdAt: new Date().toISOString(),
    sourceName,
    sourceFile,
    prompt: options.prompt?.trim() ?? "",
    warnings,
  };
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, sourceFile), options.source, "utf8");
  await fs.writeFile(path.join(dir, "intake.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return { id, sourceName, warnings, needsConfirmation: warnings.length > 0 };
}

async function readMeta(root: string, id: string): Promise<IntakeMeta> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("invalid intake id");
  const raw = await fs.readFile(path.join(stageDir(root, id), "intake.json"), "utf8");
  return JSON.parse(raw) as IntakeMeta;
}

/**
 * Validates one candidate item against the source. A quote must be copied
 * verbatim — the source itself is the only authority for a stub's quote, so
 * anything unproven (typo, paraphrase, invention) is dropped rather than
 * silently repaired.
 */
function validateItem(value: unknown, source: string): IntakeProposalItem[] {
  if (!value || typeof value !== "object") return [];
  const item = value as Record<string, unknown>;
  const type = item.type;
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const quote = typeof item.quote === "string" ? item.quote.trim() : "";
  const notes = typeof item.notes === "string" ? item.notes.trim() : undefined;
  if (
    (type !== "task" && type !== "ddr") ||
    !title ||
    title.length > 120 ||
    !quote ||
    !source.includes(quote)
  ) {
    return [];
  }
  return [{ type, title, quote, ...(notes ? { notes } : {}) }];
}

/**
 * Validates the proposal.json an agent session's `forge-intake` skill wrote for a
 * previously staged source, and stages the reviewable proposal.md. The CLI
 * never classifies — it only proves every quote came from the source.
 */
export async function applyIntake(options: {
  id: string;
  cwd?: string;
  confirmed?: boolean;
  log?: (line: string) => void;
}): Promise<{ id: string; count: number; staged: string }> {
  const root = path.resolve(options.cwd ?? process.cwd());
  const meta = await readMeta(root, options.id);
  if (meta.warnings.length > 0 && !options.confirmed) {
    throw new Error(
      "context needs confirmation before extraction; review its intake warnings first",
    );
  }
  const dir = stageDir(root, meta.id);
  const source = await fs.readFile(path.join(dir, meta.sourceFile), "utf8");
  const log = options.log ?? (() => {});

  const proposalPath = path.join(dir, "proposal.json");
  let rawItems: unknown;
  try {
    rawItems = (JSON.parse(await fs.readFile(proposalPath, "utf8")) as { items?: unknown }).items;
  } catch {
    throw new Error(
      `no proposal found at ${path.join(".forge", "intake", meta.id, "proposal.json")} — ` +
        "classify this source in your agent session first, then rerun `forge intake apply`.",
    );
  }
  if (!Array.isArray(rawItems)) {
    throw new Error('proposal.json must have an "items" array');
  }

  const items = rawItems.flatMap((value) => {
    const valid = validateItem(value, source);
    if (valid.length === 0) {
      const { title, type } = (value ?? {}) as { title?: unknown; type?: unknown };
      const named = typeof title === "string" ? `: "${title}"` : "";
      log(
        type === "artifact"
          ? `dropped an artifact request${named} — intake files tasks and decisions; classify a deliverable as a task`
          : `dropped an unverifiable item${named}`,
      );
    }
    return valid;
  });

  const proposal: IntakeProposal = { items };
  await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(dir, "proposal.md"), renderProposal(meta, proposal), "utf8");
  return {
    id: meta.id,
    count: proposal.items.length,
    staged: path.join(".forge", "intake", meta.id),
  };
}

function renderProposal(meta: IntakeMeta, proposal: IntakeProposal): string {
  const rows =
    proposal.items.length === 0
      ? [
          "_No verifiable proposals — every candidate item either lacked a source-verbatim quote or failed validation._",
        ]
      : proposal.items.flatMap((item, index) => [
          `## ${index + 1}. ${item.type} — ${item.title}`,
          "",
          `> ${item.quote}`,
          "",
          ...(item.notes ? [item.notes, ""] : []),
        ]);
  return [
    `# Intake proposal — ${meta.sourceName}`,
    "",
    "_Nothing below is in the record yet. Accepting a task adds it to the task ledger; accepting a decision stages it under `.forge/ddr/` for `forge ddr apply`. Each keeps its source as provenance._",
    "",
    ...rows,
  ].join("\n");
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 60) || "intake-item"
  );
}

async function archiveSource(root: string, meta: IntakeMeta): Promise<string> {
  const date = localIsoDate(new Date(meta.createdAt));
  const rel = path.join("context", date, `${meta.id}-${meta.sourceName}`);
  const target = path.join(root, rel);
  try {
    await fs.access(target);
  } catch {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(stageDir(root, meta.id), meta.sourceFile), target);
  }
  return rel;
}

/**
 * Stages a decision for `forge ddr apply` (TASK-305, DDR-156) and returns where.
 *
 * This used to write `decisions/DDR-###-<slug>.md` at the repo root with a
 * status no format has, numbered from the filenames — outside the record,
 * invisible to doctor and to every reader. `forge ddr apply` is the one path
 * into decisions: it allocates the id, validates the fields and writes the
 * concept. Intake knows the title and the words that raised it, not the
 * decision or why, so it stages those empty: `ddr apply` refuses until the
 * forge-ddr skill or a person fills them, which is the review this needs.
 */
async function stageDecision(
  root: string,
  item: IntakeProposalItem,
  contextSource: string,
): Promise<string> {
  const base = slug(item.title);
  // `forge ddr apply` takes a slug that starts with a letter.
  const stem = /^[a-z]/.test(base) ? base : `decision-${base}`;
  const staged = {
    title: item.title,
    status: "draft",
    contextSource,
    decision: "",
    why: "",
    quote: item.quote,
    ...(item.notes ? { notes: item.notes } : {}),
  };
  await fs.mkdir(path.join(root, ".forge", "ddr"), { recursive: true });
  for (let n = 1; ; n += 1) {
    const rel = path.join(".forge", "ddr", `${n === 1 ? stem : `${stem}-${n}`}.json`);
    try {
      await fs.writeFile(path.join(root, rel), `${JSON.stringify(staged, null, 2)}\n`, {
        encoding: "utf8",
        // Never over a decision someone else staged under the same title.
        flag: "wx",
      });
      return rel;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** Promote one reviewed proposal. This is the only path from intake into Git. */
export async function acceptIntakeItem(options: {
  id: string;
  index: number;
  cwd?: string;
}): Promise<{ target: string }> {
  const root = path.resolve(options.cwd ?? process.cwd());
  const meta = await readMeta(root, options.id);
  const proposalPath = path.join(stageDir(root, meta.id), "proposal.json");
  const proposal = JSON.parse(await fs.readFile(proposalPath, "utf8")) as IntakeProposal;
  const item = proposal.items[options.index];
  if (!item) throw new Error("intake proposal item not found");
  if (item.acceptedTarget) return { target: item.acceptedTarget };
  const source = await archiveSource(root, meta);
  let target: string;
  if (item.type === "task") {
    // Promotion writes whichever ledger this repo actually has (T-257): a
    // record gets a TASK-### with a genesis naming the intake source, a repo
    // still on v1 keeps its own grammar. Before this it always wrote
    // todo/todo.md, so an accepted item landed where the Board never looks.
    const ledger = await openTaskLedger(root);
    if (!ledger) throw new Error("this repo has no task ledger to promote into");
    const id = ledger.add({
      title: item.title,
      genesis: source,
      quote: item.quote,
      ...(item.notes ? { notes: item.notes } : {}),
    });
    await ledger.save();
    target = `${ledger.relPath}#${id}`;
  } else if (item.type === "ddr") {
    target = await stageDecision(root, item, source);
  } else {
    // A proposal applied before TASK-305 can still hold an `artifact` item.
    throw new Error(
      `item ${options.index} is an artifact request, which intake no longer files — the record has no artifacts/; make it a task`,
    );
  }
  item.acceptedTarget = target;
  await fs.writeFile(proposalPath, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(stageDir(root, meta.id), "proposal.md"),
    renderProposal(meta, proposal),
    "utf8",
  );
  return { target };
}
