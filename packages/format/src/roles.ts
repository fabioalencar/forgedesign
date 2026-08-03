// UserRoles.md (spec/format.md §4, "Stakeholders.md, UserRoles.md, …") —
// ROLE-### entries, flat (no `##` sections).
//
// The spec gives these rows no fixed field set, deliberately: an entry declares
// "what the role can see/do in the prototype" in whatever terms the project
// uses. So this parses the generic ledger shape and leaves the fields alone —
// what makes UserRoles special is not its grammar but its consumer, since these
// entries (with DataModel.md) are the runtime inputs that seed the role switcher
// on a hosted review.

import { type LedgerDocument, parseLedger, serializeLedger } from "./ledger.js";

export function parseUserRoles(text: string): LedgerDocument {
  return parseLedger(text, { checkbox: false });
}

export function serializeUserRoles(doc: LedgerDocument): string {
  return serializeLedger(doc);
}
