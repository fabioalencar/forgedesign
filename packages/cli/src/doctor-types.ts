// Shared shapes for `forge doctor`. doctor.ts dispatches and doctor-v02.ts holds
// the rules, so the types live here rather than in either, to keep the imports
// acyclic. There were two rule sets until DDR-095; there is one now.

export type DoctorSeverity = "error" | "warning";

export interface DoctorFinding {
  rule: string;
  severity: DoctorSeverity;
  message: string;
  file?: string;
}

export interface DoctorResult {
  findings: DoctorFinding[];
  exitCode: 0 | 1 | 2;
}

export function finding(
  rule: string,
  message: string,
  file?: string,
  severity: DoctorSeverity = "error",
): DoctorFinding {
  return file ? { rule, severity, message, file } : { rule, severity, message };
}
