// Check reports (spec/format.md §5 "design/checks/<tag>/<checker>.md", DDR-127).
//
// Forge specifies the report and never the checker: any command that prints
// this JSON shape is a checker, and `forge check` turns what it printed into a
// derived Check concept beside a verbatim JSON sidecar. The shape is the
// cross-tool contract — a scanner, a token linter, doctor itself — so it lives
// in the format package, where the CLI, the hub and the handoff pack read one
// definition of it.

export const CHECK_SEVERITIES = ["error", "warning", "info"] as const;
export type CheckSeverity = (typeof CHECK_SEVERITIES)[number];

export interface CheckFinding {
  /** the checker's own rule id, e.g. `contrast-aa` or doctor's `unresolved-ref` */
  rule: string;
  severity: CheckSeverity;
  message: string;
  /** where in the prototype, when the finding is about something on screen */
  route?: string;
  selector?: string;
  /** where in the repository, when the finding is about a file */
  file?: string;
  /** what would resolve it, when the checker knows */
  fix?: string;
}

export interface CheckReport {
  /** the checker's name; the file is named by it */
  checker: string;
  /** the checker's own version, when it reports one */
  version: string | null;
  /** an optional overall number the checker computes; Forge never derives one */
  score: number | null;
  /** one line the checker wants read first, when it offers one */
  summary: string | null;
  findings: CheckFinding[];
}

const MAX_TEXT = 4000;
const MAX_FINDINGS = 5000;

const text = (value: unknown, field: string, where: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where}: "${field}" is required`);
  }
  if (value.length > MAX_TEXT)
    throw new Error(`${where}: "${field}" exceeds ${MAX_TEXT} characters`);
  return value.trim();
};

const optionalText = (value: unknown, field: string, where: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${where}: "${field}" must be a string`);
  if (value.length > MAX_TEXT)
    throw new Error(`${where}: "${field}" exceeds ${MAX_TEXT} characters`);
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

/**
 * Reads what a checker printed. Every finding is validated before the report
 * is accepted, and a report that is not this shape is refused with the field
 * named — a checker that prints something else has not produced a check.
 */
export function parseCheckReport(value: unknown): CheckReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("a check report is a JSON object");
  }
  const raw = value as Record<string, unknown>;
  const checker = text(raw.checker, "checker", "check report");
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(checker)) {
    throw new Error(
      `check report: "checker" must be a name usable as a filename — got "${checker}"`,
    );
  }
  const findingsRaw = raw.findings;
  if (!Array.isArray(findingsRaw)) throw new Error('check report: "findings" must be an array');
  if (findingsRaw.length > MAX_FINDINGS) {
    throw new Error(
      `check report: more than ${MAX_FINDINGS} findings is not a report, it is a dump`,
    );
  }
  const findings = findingsRaw.map((item, index): CheckFinding => {
    const where = `finding ${index + 1}`;
    if (typeof item !== "object" || item === null) throw new Error(`${where}: expected an object`);
    const f = item as Record<string, unknown>;
    const severity = f.severity;
    if (!(CHECK_SEVERITIES as readonly unknown[]).includes(severity)) {
      throw new Error(
        `${where}: "severity" must be one of ${CHECK_SEVERITIES.join(", ")} — got ${JSON.stringify(severity)}`,
      );
    }
    const finding: CheckFinding = {
      rule: text(f.rule, "rule", where),
      severity: severity as CheckSeverity,
      message: text(f.message, "message", where),
    };
    const route = optionalText(f.route, "route", where);
    const selector = optionalText(f.selector, "selector", where);
    const file = optionalText(f.file, "file", where);
    const fix = optionalText(f.fix, "fix", where);
    if (route !== undefined) finding.route = route;
    if (selector !== undefined) finding.selector = selector;
    if (file !== undefined) finding.file = file;
    if (fix !== undefined) finding.fix = fix;
    return finding;
  });
  let score: number | null = null;
  if (raw.score !== undefined && raw.score !== null) {
    if (typeof raw.score !== "number" || !Number.isFinite(raw.score)) {
      throw new Error('check report: "score" must be a number when given');
    }
    score = raw.score;
  }
  return {
    checker,
    version: optionalText(raw.version, "version", "check report") ?? null,
    score,
    summary: optionalText(raw.summary, "summary", "check report") ?? null,
    findings,
  };
}

/** How many findings a report holds at each severity. */
export function countFindings(report: CheckReport): Record<CheckSeverity, number> {
  const counts: Record<CheckSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of report.findings) counts[finding.severity] += 1;
  return counts;
}

/** `2 errors, 1 warning, 3 info` — or `no findings`. */
export function describeFindings(report: CheckReport): string {
  const counts = countFindings(report);
  const parts = [
    counts.error > 0 ? `${counts.error} error${counts.error === 1 ? "" : "s"}` : "",
    counts.warning > 0 ? `${counts.warning} warning${counts.warning === 1 ? "" : "s"}` : "",
    counts.info > 0 ? `${counts.info} info` : "",
  ].filter(Boolean);
  return parts.length === 0 ? "no findings" : parts.join(", ");
}
