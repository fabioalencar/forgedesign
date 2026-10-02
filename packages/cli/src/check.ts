// `forge check` (TASK-456, DDR-127): one contract instead of three claims.
//
// Three things used to claim "check" and one ran: doctor lints the record,
// the forge-review skill is advisory by design, and the Cloud gate is accepted and
// unbuilt. This command makes a check a *report the record keeps* — a derived
// Check concept at `design/checks/<tag>/<checker>.md`, one per checker, with a
// verbatim JSON sidecar — and runs whatever produces one: doctor, always, and
// every checker named in `forge.json#checks`. Forge specifies the report and
// never the checker, so a scanner the brief calls "optional, never required"
// stays exactly that. `forge freeze --require-check` then refuses to tag a
// commit no report describes.
//
// The forge-review skill is not run here, on purpose: it is an agent's work, the CLI
// dispatches no model (DDR-050), and its findings are feedback rather than a
// report (DDR-108). A report says what a tool found; feedback says what a
// person should decide.

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  type CheckFinding,
  type CheckReport,
  countFindings,
  describeFindings,
  parseCheckReport,
  scanBundle,
  withFrontmatter,
} from "@forgedesign/format";
import { writeBundleIndex } from "./bundle-index.js";
import { runDoctor } from "./doctor.js";
import { todayIsoDate } from "./freezes.js";
import { git, headCommit, requireRepoRoot } from "./git.js";
import { splitCommand } from "./preview.js";
import { type CheckConfig, readProjectFile } from "./project.js";
import { requireCurrentRecord } from "./record-version.js";

const execFileAsync = promisify(execFile);

/** The record's own checker; it needs no configuration and always runs. */
export const DOCTOR_CHECKER = "doctor";
const CLI_VERSION = "0.1.0";
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * `forge.json#checks`, validated: each entry names a report file and says what
 * to run. A name that would collide with doctor's, or with another entry's,
 * is refused rather than overwritten.
 */
export function readCheckConfigs(project: { checks?: unknown }): CheckConfig[] {
  const raw = project.checks;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new Error('forge.json "checks" must be an array of { name, command }');
  const seen = new Set<string>([DOCTOR_CHECKER]);
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`forge.json "checks"[${index}] must be an object with name and command`);
    }
    const { name, command, dir } = entry as Record<string, unknown>;
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      throw new Error(
        `forge.json "checks"[${index}]: "name" must be a filename-safe name — got ${JSON.stringify(name)}`,
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `forge.json "checks": "${name}" is ${name === DOCTOR_CHECKER ? "doctor's own name" : "listed twice"}`,
      );
    }
    seen.add(name);
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error(`forge.json "checks"[${index}] ("${name}"): "command" is required`);
    }
    if (dir !== undefined && typeof dir !== "string") {
      throw new Error(`forge.json "checks"[${index}] ("${name}"): "dir" must be a string`);
    }
    return { name, command, ...(dir ? { dir } : {}) };
  });
}

export interface CheckOutcome {
  checker: string;
  /** repo-relative path of the concept written */
  path: string;
  findings: number;
  errors: number;
  score: number | null;
}

export interface RunCheckResult {
  tag: string;
  commit: string;
  /** repo-relative directory holding this tag's reports */
  dir: string;
  reports: CheckOutcome[];
}

export interface RunCheckOptions {
  /** the version these reports are for — the tag `forge freeze` will cut */
  tag: string;
  cwd?: string;
  log?: (line: string) => void;
}

/** Paths changed outside the reports themselves and the index they regenerate. */
async function dirtyOutsideChecks(root: string, recordRoot: string): Promise<string[]> {
  const out = await git(root, [
    "status",
    "--porcelain",
    "--",
    ".",
    `:(exclude)${recordRoot}/checks`,
    `:(exclude)${recordRoot}/index.md`,
  ]);
  return out.split("\n").filter((line) => line.trim() !== "");
}

/**
 * Runs one configured checker and reads what it printed. A checker that exits
 * non-zero, prints something other than JSON, or prints a JSON that is not a
 * report has not produced a check — each failure names the checker and quotes
 * what it did say, so a broken integration is diagnosable from the message.
 */
async function runChecker(root: string, config: CheckConfig): Promise<CheckReport> {
  const argv = splitCommand(config.command);
  const executable = argv[0];
  if (!executable) throw new Error(`checker "${config.name}": the command is empty`);
  const cwd = path.resolve(root, config.dir?.trim() || ".");
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(executable, argv.slice(1), {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
    }));
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(`checker "${config.name}" failed to run:\n${stderr.trim() || String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(
      `checker "${config.name}" did not print a JSON report — it ended with: ${stdout.trim().slice(-200) || "(nothing)"}`,
    );
  }
  try {
    return parseCheckReport(parsed);
  } catch (error) {
    throw new Error(`checker "${config.name}": ${(error as Error).message}`);
  }
}

/** doctor's findings in the report contract's shape. */
function doctorReport(
  findings: { rule: string; severity: string; message: string; file?: string }[],
): CheckReport {
  return {
    checker: DOCTOR_CHECKER,
    version: CLI_VERSION,
    score: null,
    summary:
      findings.length === 0 ? "forge doctor: clean" : `forge doctor: ${findings.length} finding(s)`,
    findings: findings.map(
      (finding): CheckFinding => ({
        rule: finding.rule,
        severity: finding.severity === "warning" ? "warning" : "error",
        message: finding.message,
        ...(finding.file ? { file: finding.file } : {}),
      }),
    ),
  };
}

/** One finding as a line of the fenced block — a literal, so ids inside it are not references. */
function findingLine(finding: CheckFinding): string {
  const where = [finding.file, finding.route, finding.selector].filter(Boolean).join(" ");
  return [
    finding.severity.padEnd(7),
    finding.rule,
    finding.message,
    where ? `· ${where}` : "",
    finding.fix ? `→ ${finding.fix}` : "",
  ]
    .filter((part) => part !== "")
    .join("  ");
}

/**
 * The Check concept and its sidecar. The Markdown is what a person and doctor
 * read; the JSON is the report verbatim, for whatever renders or compares it
 * later (the hub, the handoff pack, a Cloud gate reading the series). Findings
 * sit in a fenced block because a checker's message may quote a record id —
 * doctor's own do — and a quoted id must stay a literal (DDR-069).
 */
async function writeReport(
  root: string,
  dir: string,
  report: CheckReport,
  meta: { tag: string; commit: string; date: string; at: string; command: string },
): Promise<CheckOutcome> {
  const counts = countFindings(report);
  const relPath = path.join(dir, `${report.checker}.md`);
  const summary = `${report.checker} checked ${meta.tag} at commit ${meta.commit.slice(0, 7)}: ${describeFindings(report)}.${report.summary ? ` ${report.summary}` : ""}`;
  const body = [
    `<!-- generated by forge check · ${meta.tag} · do not edit -->`,
    "",
    summary,
    "",
    "## Findings",
    "",
    ...(report.findings.length === 0
      ? ["No findings."]
      : ["```text", ...report.findings.map(findingLine), "```"]),
    "",
  ].join("\n");
  await fs.writeFile(
    path.join(root, relPath),
    withFrontmatter(
      {
        type: "Check",
        title: `${report.checker} on ${meta.tag}`,
        checker: report.checker,
        version: report.version ?? undefined,
        target: meta.tag,
        commit: meta.commit,
        date: meta.date,
        command: meta.command,
        score: report.score ?? undefined,
        findings: report.findings.length,
        errors: counts.error,
        warnings: counts.warning,
        generated: { by: "forge check", at: meta.at },
      },
      body,
    ),
    "utf8",
  );
  await fs.writeFile(
    path.join(root, dir, `${report.checker}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return {
    checker: report.checker,
    path: relPath,
    findings: report.findings.length,
    errors: counts.error,
    score: report.score,
  };
}

/**
 * Runs every checker and writes one report each under
 * `<recordRoot>/checks/<tag>/`. The tree must be clean apart from earlier
 * reports: a report names the commit it checked, and a dirty tree would make
 * that name a lie about what was actually looked at.
 */
export async function runCheck(options: RunCheckOptions): Promise<RunCheckResult> {
  const log = options.log ?? (() => {});
  const root = await requireRepoRoot(options.cwd);
  const { recordRoot } = await requireCurrentRecord(root);
  if (!NAME_RE.test(options.tag)) {
    throw new Error(`"${options.tag}" is not a tag name — letters, digits, dots, dashes`);
  }
  const dirty = await dirtyOutsideChecks(root, recordRoot);
  if (dirty.length > 0) {
    throw new Error(
      `working tree is not clean (${dirty.length} path(s)) — a report names the commit it checked, so commit or stash first`,
    );
  }
  const configs = readCheckConfigs(await readProjectFile(root));
  const commit = await headCommit(root);
  const date = todayIsoDate();
  const at = new Date().toISOString();
  const dir = path.join(recordRoot, "checks", options.tag);
  await fs.mkdir(path.join(root, dir), { recursive: true });

  const reports: CheckOutcome[] = [];
  log("Running doctor…");
  const doctor = await runDoctor(root);
  const meta = { tag: options.tag, commit, date, at };
  reports.push(
    await writeReport(root, dir, doctorReport(doctor.findings), {
      ...meta,
      command: "forge doctor",
    }),
  );
  for (const config of configs) {
    log(`Running ${config.name}…`);
    const report = await runChecker(root, config);
    reports.push(
      await writeReport(
        root,
        dir,
        { ...report, checker: config.name },
        { ...meta, command: config.command },
      ),
    );
  }
  // A new concept changes the bundle listing, so the writer keeps the index true (T-300).
  await writeBundleIndex(root);
  return { tag: options.tag, commit, dir, reports };
}

export interface CheckGaps {
  /** checkers with no report under checks/<tag>/ */
  missing: string[];
  /** checkers whose report names a commit that differs from HEAD beyond the reports themselves */
  stale: string[];
}

/** True when nothing but check reports and the index changed between two commits. */
async function onlyChecksChanged(
  root: string,
  recordRoot: string,
  from: string,
  to: string,
): Promise<boolean> {
  try {
    await git(root, [
      "diff",
      "--quiet",
      from,
      to,
      "--",
      ".",
      `:(exclude)${recordRoot}/checks`,
      `:(exclude)${recordRoot}/index.md`,
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether every expected checker — doctor and each `forge.json#checks` entry —
 * has a report under `checks/<tag>/` that describes `head`. A report describes
 * a commit when it names it, or when the only difference since is the reports
 * themselves: `forge check` commits after it runs, so the tag lands one commit
 * past the one the reports name, and that is not staleness.
 */
export async function checksSatisfied(
  root: string,
  recordRoot: string,
  tag: string,
  head: string,
): Promise<CheckGaps> {
  const expected = [
    DOCTOR_CHECKER,
    ...readCheckConfigs(await readProjectFile(root)).map((config) => config.name),
  ];
  const bundle = await scanBundle(root, { recordRoot });
  const commits = new Map<string, string | null>();
  for (const concept of bundle.concepts) {
    if (concept.type !== "Check") continue;
    const match = /^checks\/([^/]+)\/([^/]+)\.md$/.exec(concept.relPath);
    if (!match || match[1] !== tag) continue;
    const commit = concept.frontmatter.commit;
    commits.set(match[2] as string, typeof commit === "string" ? commit : null);
  }
  const missing: string[] = [];
  const stale: string[] = [];
  for (const name of expected) {
    if (!commits.has(name)) {
      missing.push(name);
      continue;
    }
    const commit = commits.get(name) ?? null;
    if (commit === head) continue;
    if (commit !== null && (await onlyChecksChanged(root, recordRoot, commit, head))) continue;
    stale.push(name);
  }
  return { missing, stale };
}
