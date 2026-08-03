// Round-trip-safe parser/writer for todo/todo.md (spec §6).
//
// The raw lines of each block are authoritative: parsing keeps every line
// verbatim, and serializing a document that was never mutated reproduces the
// input byte for byte (DDR-007). Mutation helpers regenerate only the lines
// they touch. Shared with the dashboard board view via the `@forgedesign/cli/todo`
// export.

export interface TaskField {
  key: string;
  value: string;
}

export interface TodoTask {
  /** "T-014"-style permanent id, or null for un-IDed bullets */
  id: string | null;
  checked: boolean;
  /** bullet text minus checkbox and id */
  title: string;
  fields: TaskField[];
  /** authoritative raw lines: bullet line + indented continuation lines */
  lines: string[];
}

export type SectionBlock = { kind: "raw"; lines: string[] } | { kind: "task"; task: TodoTask };

export interface TodoSection {
  /** heading text, e.g. "Backlog" or "Inbox — alpha" */
  heading: string;
  /** raw heading line as written */
  headingLine: string;
  blocks: SectionBlock[];
}

export interface TodoDocument {
  /** raw lines before the first `##` heading */
  preamble: string[];
  sections: TodoSection[];
  /** whether the file ended with a newline */
  trailingNewline: boolean;
}

const SECTION_RE = /^##\s+(.+?)\s*$/;
const TASK_RE = /^- \[( |x|X)\] (.*)$/;
const ID_RE = /^(T-\d+)\s*(.*)$/;
const FIELD_RE = /^\s+([A-Za-z][\w-]*):\s?(.*)$/;
/** continuation line: indented, belongs to the task above (incl. nested bullets) */
const CONTINUATION_RE = /^\s+\S/;

function parseTaskBulletLine(line: string): Pick<TodoTask, "id" | "checked" | "title"> | null {
  const bullet = line.match(TASK_RE);
  if (!bullet) return null;
  const rest = bullet[2] ?? "";
  const idMatch = rest.match(ID_RE);
  return {
    checked: bullet[1] !== " ",
    id: idMatch?.[1] ?? null,
    title: (idMatch ? (idMatch[2] ?? "") : rest).trim(),
  };
}

function parseFields(continuationLines: string[]): TaskField[] {
  const fields: TaskField[] = [];
  for (const line of continuationLines) {
    const m = line.match(FIELD_RE);
    if (m?.[1] !== undefined) fields.push({ key: m[1], value: (m[2] ?? "").trim() });
  }
  return fields;
}

export function parseTodo(text: string): TodoDocument {
  const trailingNewline = text.endsWith("\n");
  const lines = trailingNewline ? text.slice(0, -1).split("\n") : text.split("\n");

  const doc: TodoDocument = { preamble: [], sections: [], trailingNewline };
  let section: TodoSection | null = null;

  const pushRaw = (line: string) => {
    if (!section) {
      doc.preamble.push(line);
      return;
    }
    const last = section.blocks.at(-1);
    if (last?.kind === "raw") last.lines.push(line);
    else section.blocks.push({ kind: "raw", lines: [line] });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const headingMatch = line.match(SECTION_RE);
    if (headingMatch?.[1]) {
      section = { heading: headingMatch[1], headingLine: line, blocks: [] };
      doc.sections.push(section);
      continue;
    }

    const bullet = section ? parseTaskBulletLine(line) : null;
    if (section && bullet) {
      const taskLines = [line];
      while (i + 1 < lines.length && CONTINUATION_RE.test(lines[i + 1]!)) {
        i++;
        taskLines.push(lines[i]!);
      }
      section.blocks.push({
        kind: "task",
        task: { ...bullet, fields: parseFields(taskLines.slice(1)), lines: taskLines },
      });
      continue;
    }

    pushRaw(line);
  }

  return doc;
}

export function serializeTodo(doc: TodoDocument): string {
  const out: string[] = [...doc.preamble];
  for (const section of doc.sections) {
    out.push(section.headingLine);
    for (const block of section.blocks) {
      out.push(...(block.kind === "raw" ? block.lines : block.task.lines));
    }
  }
  return out.join("\n") + (doc.trailingNewline ? "\n" : "");
}

// --- queries ---

export function findSection(doc: TodoDocument, heading: string): TodoSection | undefined {
  return doc.sections.find((s) => s.heading === heading);
}

export function findTask(
  doc: TodoDocument,
  id: string,
): { section: TodoSection; task: TodoTask } | undefined {
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.kind === "task" && block.task.id === id) {
        return { section, task: block.task };
      }
    }
  }
  return undefined;
}

export function tasksInSection(section: TodoSection): TodoTask[] {
  return section.blocks
    .filter((b): b is { kind: "task"; task: TodoTask } => b.kind === "task")
    .map((b) => b.task);
}

export function openCountsBySection(doc: TodoDocument): Array<{ section: string; open: number }> {
  return doc.sections.map((s) => ({
    section: s.heading,
    open: tasksInSection(s).filter((t) => !t.checked).length,
  }));
}

/** Next unused T-### id across the whole document (ids are permanent, spec §6). */
export function nextTaskId(doc: TodoDocument): string {
  let max = 0;
  for (const section of doc.sections) {
    for (const task of tasksInSection(section)) {
      const n = task.id ? Number.parseInt(task.id.slice(2), 10) : 0;
      if (n > max) max = n;
    }
  }
  return `T-${String(max + 1).padStart(3, "0")}`;
}

export function getField(task: TodoTask, key: string): string | undefined {
  return task.fields.find((f) => f.key === key)?.value;
}

// --- mutations (each regenerates only the lines it touches) ---

function isBlankRaw(block: SectionBlock): boolean {
  return block.kind === "raw" && block.lines.every((l) => l.trim() === "");
}

export function setChecked(task: TodoTask, checked: boolean): void {
  if (task.checked === checked) return;
  task.checked = checked;
  task.lines[0] = task.lines[0]!.replace(/^- \[( |x|X)\]/, `- [${checked ? "x" : " "}]`);
}

/** Rewrites the bullet line's title, preserving the checkbox and id. */
export function setTitle(task: TodoTask, title: string): void {
  task.title = title;
  const box = task.checked ? "x" : " ";
  const idPart = task.id ? `${task.id} ` : "";
  task.lines[0] = `- [${box}] ${idPart}${title}`.trimEnd();
}

/** Updates a field in place, or inserts it after the last existing field (or the bullet). */
export function setField(task: TodoTask, key: string, value: string): void {
  const existing = task.fields.find((f) => f.key === key);
  const fieldRe = new RegExp(`^(\\s+)${key}:`);
  if (existing) {
    existing.value = value;
    const i = task.lines.findIndex((l) => fieldRe.test(l));
    if (i !== -1) {
      const indent = task.lines[i]!.match(/^\s+/)?.[0] ?? "  ";
      task.lines[i] = `${indent}${key}: ${value}`.trimEnd();
      return;
    }
  }
  task.fields.push({ key, value });
  let insertAt = 1;
  for (let i = task.lines.length - 1; i >= 1; i--) {
    if (FIELD_RE.test(task.lines[i]!)) {
      insertAt = i + 1;
      break;
    }
  }
  task.lines.splice(insertAt, 0, `  ${key}: ${value}`.trimEnd());
}

/** Removes a field and its line, if present. No-op when the field is absent. */
export function removeField(task: TodoTask, key: string): void {
  const idx = task.fields.findIndex((f) => f.key === key);
  if (idx === -1) return;
  task.fields.splice(idx, 1);
  const fieldRe = new RegExp(`^\\s+${key}:`);
  const lineIdx = task.lines.findIndex((l) => fieldRe.test(l));
  if (lineIdx !== -1) task.lines.splice(lineIdx, 1);
}

export interface NewTask {
  id: string;
  title: string;
  checked?: boolean;
  fields?: TaskField[];
}

const PHASE_RE = /^###\s+(.+?)\s*$/;

export function phaseHeading(line: string): string | null {
  return line.match(PHASE_RE)?.[1] ?? null;
}

/** All `###` phase labels in a section, in file order. */
export function phasesInSection(section: TodoSection): string[] {
  return section.blocks.flatMap((block) =>
    block.kind === "raw"
      ? block.lines.flatMap((line) => {
          const heading = phaseHeading(line);
          return heading ? [heading] : [];
        })
      : [],
  );
}

export interface BacklogPhase {
  heading: string;
  tasks: Array<{ id: string; title: string }>;
}

/**
 * Backlog phases (`###` headings) with their open tasks, for dashboard/plan
 * UIs. Reuses the same grammar as phasesInSection so displays can never
 * disagree with the file's actual structure.
 */
export function backlogPhases(doc: TodoDocument): BacklogPhase[] {
  const backlog = findSection(doc, "Backlog");
  if (!backlog) return [];

  const phases: Array<{ heading: string; taskIds: string[] }> = [];
  let current: { heading: string; taskIds: string[] } | null = null;
  for (const block of backlog.blocks) {
    if (block.kind === "raw") {
      for (const line of block.lines) {
        const heading = phaseHeading(line);
        if (heading) {
          current = { heading, taskIds: [] };
          phases.push(current);
        }
      }
      continue;
    }
    if (!block.task.checked && block.task.id && current) {
      current.taskIds.push(block.task.id);
    }
  }

  return phases
    .filter((p) => p.taskIds.length > 0)
    .map((p) => ({
      heading: p.heading,
      tasks: p.taskIds.map((id) => ({ id, title: findTask(doc, id)?.task.title ?? "" })),
    }));
}

function buildTask(input: NewTask): TodoTask {
  const fields = input.fields ?? [];
  const lines = [
    `- [${input.checked ? "x" : " "}] ${input.id} ${input.title}`.trimEnd(),
    ...fields.map((f) => `  ${f.key}: ${f.value}`.trimEnd()),
  ];
  return { id: input.id, checked: input.checked ?? false, title: input.title, fields, lines };
}

/**
 * Appends after the section's last content, keeping any trailing blank lines
 * (the separator before the next heading) where they were. New tasks sit
 * adjacent to a preceding task, or after one blank line otherwise.
 */
function appendTaskBlock(section: TodoSection, task: TodoTask): void {
  let end = section.blocks.length;
  while (end > 0 && isBlankRaw(section.blocks[end - 1]!)) end--;
  const trailing = section.blocks.splice(end);
  const lastContent = section.blocks.at(-1);
  if (lastContent?.kind !== "task") {
    section.blocks.push({ kind: "raw", lines: [""] });
  }
  section.blocks.push({ kind: "task", task });
  section.blocks.push(...trailing);
}

function getOrCreateSection(doc: TodoDocument, heading: string): TodoSection {
  let section = findSection(doc, heading);
  if (section) return section;
  const lastBlock = doc.sections.at(-1)?.blocks.at(-1);
  if (doc.sections.length > 0 && (!lastBlock || !isBlankRaw(lastBlock))) {
    doc.sections.at(-1)!.blocks.push({ kind: "raw", lines: [""] });
  }
  section = { heading, headingLine: `## ${heading}`, blocks: [] };
  doc.sections.push(section);
  return section;
}

/** Appends a task to a section, creating the section (e.g. "Inbox — <tag>") if missing. */
export function addTask(doc: TodoDocument, sectionHeading: string, input: NewTask): TodoTask {
  const task = buildTask(input);
  appendTaskBlock(getOrCreateSection(doc, sectionHeading), task);
  return task;
}

/**
 * Adds a `###` phase heading to an existing section. Phase labels are unique
 * case-insensitively so `forge loop <phase>` can never become ambiguous just
 * because the Board authored two visually identical groups.
 */
export function addPhase(doc: TodoDocument, sectionHeading: string, label: string): boolean {
  const section = findSection(doc, sectionHeading);
  if (!section) return false;
  const title = label.trim();
  if (!title) throw new Error("phase title is required");
  if (phasesInSection(section).some((phase) => phase.toLowerCase() === title.toLowerCase())) {
    throw new Error(`phase "${title}" already exists in ${sectionHeading}`);
  }

  let end = section.blocks.length;
  while (end > 0 && isBlankRaw(section.blocks[end - 1]!)) end--;
  const trailing = section.blocks.splice(end);
  if (section.blocks.length > 0) section.blocks.push({ kind: "raw", lines: [""] });
  section.blocks.push({ kind: "raw", lines: [`### ${title}`] });
  section.blocks.push(...trailing);
  return true;
}

/**
 * Moves a task block verbatim to the end of another section (created if
 * missing). Collapses the blank line left behind so the source section
 * doesn't accumulate gaps.
 */
export function moveTask(doc: TodoDocument, id: string, targetHeading: string): boolean {
  const located = findTask(doc, id);
  if (!located) return false;

  const source = located.section;
  const index = source.blocks.findIndex((b) => b.kind === "task" && b.task.id === id);
  source.blocks.splice(index, 1);
  const before = source.blocks[index - 1];
  const after = source.blocks[index];
  if (before && after && isBlankRaw(before) && isBlankRaw(after)) {
    source.blocks.splice(index, 1);
  } else if (before && !after && isBlankRaw(before)) {
    source.blocks.splice(index - 1, 1);
  }

  appendTaskBlock(getOrCreateSection(doc, targetHeading), located.task);
  return true;
}

/** Split one raw block so a phase heading becomes a stable insertion marker. */
function isolatePhaseBlock(section: TodoSection, label: string): number | null {
  for (const [blockIndex, block] of section.blocks.entries()) {
    if (block.kind !== "raw") continue;
    const lineIndex = block.lines.findIndex((line) => phaseHeading(line) === label);
    if (lineIndex === -1) continue;

    const replacement: SectionBlock[] = [];
    const before = block.lines.slice(0, lineIndex);
    const after = block.lines.slice(lineIndex + 1);
    if (before.length > 0) replacement.push({ kind: "raw", lines: before });
    replacement.push({ kind: "raw", lines: [block.lines[lineIndex]!] });
    if (after.length > 0) replacement.push({ kind: "raw", lines: after });
    section.blocks.splice(blockIndex, 1, ...replacement);
    return blockIndex + (before.length > 0 ? 1 : 0);
  }
  return null;
}

/**
 * Moves a task directly beneath a `###` phase and after that phase's existing
 * cards. Unlike moveTask, the destination section and phase must already
 * exist; Board actions use this to avoid creating arbitrary headings.
 */
export function moveTaskToPhase(
  doc: TodoDocument,
  id: string,
  targetHeading: string,
  targetPhase: string,
): boolean {
  const located = findTask(doc, id);
  const target = findSection(doc, targetHeading);
  if (!located || !target) return false;
  if (!phasesInSection(target).includes(targetPhase)) return false;

  const source = located.section;
  const sourceIndex = source.blocks.findIndex((b) => b.kind === "task" && b.task.id === id);
  source.blocks.splice(sourceIndex, 1);
  const before = source.blocks[sourceIndex - 1];
  const after = source.blocks[sourceIndex];
  if (before && after && isBlankRaw(before) && isBlankRaw(after)) {
    source.blocks.splice(sourceIndex, 1);
  } else if (before && !after && isBlankRaw(before)) {
    source.blocks.splice(sourceIndex - 1, 1);
  }

  const phaseIndex = isolatePhaseBlock(target, targetPhase);
  if (phaseIndex === null) return false;

  let nextPhaseIndex: number | null = null;
  for (let index = phaseIndex + 1; index < target.blocks.length; index++) {
    const block = target.blocks[index]!;
    if (block.kind !== "raw") continue;
    if (block.lines.some((line) => phaseHeading(line) !== null)) {
      const label = block.lines.find((line) => phaseHeading(line) !== null)!;
      nextPhaseIndex = isolatePhaseBlock(target, phaseHeading(label)!);
      break;
    }
  }

  let insertAt = nextPhaseIndex ?? target.blocks.length;
  while (insertAt > phaseIndex + 1 && isBlankRaw(target.blocks[insertAt - 1]!)) insertAt--;
  target.blocks.splice(insertAt, 0, { kind: "task", task: located.task });
  return true;
}
