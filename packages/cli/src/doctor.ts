// `forge doctor` — the format's contract enforcement.
//
// One rule set, in doctor-v02.ts (spec §7, OKF conformance over the design/
// bundle). This file is the dispatcher and nothing else.
//
// It used to hold a second set: seven rules over the v0.1 root file set, chosen
// by `forge.json#formatVersion` and returning early for v0.2. DDR-095 deleted
// them — v0.1 is a migration source, not a supported format, so an unmigrated
// record gets one finding naming `forge upgrade` rather than a validation of a
// shape the format has left. The duplication was not merely bulk: TASK-328 wrote
// a fix into the v0.1 half and it governed nothing, because a v0.2 record never
// reached it, and no gate could report that — the code was imported, so knip saw
// it as live, and it was unreachable rather than unused.
//
// Exit codes: 0 = clean, 1 = findings, 2 = unparseable record.

import {
  type DoctorFinding,
  type DoctorResult,
  type DoctorSeverity,
  finding,
} from "./doctor-types.js";
import { runDoctorV02 } from "./doctor-v02.js";
import { readRecordVersion, versionRefusal } from "./record-version.js";

export type { DoctorFinding, DoctorResult, DoctorSeverity };

export interface DoctorOptions {
  /** git ref accepted decisions are compared against; defaults to HEAD */
  base?: string;
}

export async function runDoctor(root: string, options: DoctorOptions = {}): Promise<DoctorResult> {
  const version = await readRecordVersion(root);

  if (version.kind === "current") {
    return await runDoctorV02(root, version.manifest, {
      recordRoot: version.recordRoot,
      base: options.base,
    });
  }

  // Exit 2 is "there is no record to check here", which is a different thing
  // from "the record is wrong" and scripts distinguish them. An old record is
  // a real record with one finding against it, so it exits 1 like any other.
  const unreadable = version.kind === "absent" || version.kind === "unparseable";
  // No file when there is no manifest — which includes a pre-0.1 record, since
  // that layout never had one. Naming forge.json as the location of a finding
  // about a repo that does not contain forge.json reads as a broken path.
  const hasManifest = !(
    version.kind === "absent" ||
    (version.kind === "migratable" && version.version === null)
  );
  const file = hasManifest ? "forge.json" : undefined;
  return {
    findings: [
      finding(unreadable ? "unparseable" : "format-version", versionRefusal(version), file),
    ],
    exitCode: unreadable ? 2 : 1,
  };
}
