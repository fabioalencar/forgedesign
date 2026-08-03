---
name: intake
description: Classify a staged transcript, meeting note, or other raw context into candidate tasks/decisions/artifacts for the design record (DDR-021). Use when the user asks to "intake" a transcript, meeting note, or other context source, or points you at a file staged under .forge/intake/.
---

# intake

Turns raw context (a call transcript, meeting notes, a long chat log) into reviewable
candidates: `TASK-###`s for the task ledger, DDR stubs for decisions/, or artifact requests. This
skill classifies; it never promotes anything into the record itself — a human reviews and
accepts each candidate individually afterward (`acceptIntakeItem`, e.g. from the dashboard
timeline). `forge intake apply` is the only thing that turns your classification into a
reviewable proposal, and it re-verifies every quote against the source itself, so it cannot
be fooled by a hallucinated or paraphrased one.

## Steps

1. **Stage the source, if it isn't already.** If you were handed a raw file (not a
   `.forge/intake/<id>/` path or id):
   ```bash
   forge intake <file>
   ```
   This prints the staged id and any quality warnings (short transcript, a timeline gap,
   no timestamps). Note the id — you'll need it for `apply`.

2. **Read the staged source** at `.forge/intake/<id>/source-<name>` (the exact file
   `forge intake` staged — check the command's output for the filename). Do not read the
   original file directly; classify from the staged copy so what you quote is guaranteed to
   be what `apply` will check against.

3. **Classify.** For each candidate worth surfacing, decide:
   - `type`: `"task"` (something to do), `"ddr"` (a decision that was made or needs to be
     — this stages a stub only; the `ddr` skill fills in the real Why/Alternatives later),
     or `"artifact"` (a deliverable request — user-flows, journey-maps,
     service-blueprints, site-audits, personas, competitive-analysis, user-stories,
     data-model, or process-flow).
   - `title` — short, specific, **120 characters or fewer**.
   - `quote` — **copied verbatim, character-for-character, from the staged source.**
     `forge intake apply` drops any item whose quote isn't an exact substring of the source
     — paraphrasing, fixing a typo, or condensing it will silently lose the item. If you
     can't find a clean verbatim quote for something, either search harder in the source
     text or leave it out; never approximate one.
   - `notes` (optional) — your own gloss, clearly distinguished from the quote itself.
   - `artifactType` — required, and only, when `type` is `"artifact"`.

   Don't force everything into a candidate. A transcript's small talk, tangents, and
   already-tracked topics don't need one.

4. **Write the proposal.** Save your classification to
   `.forge/intake/<id>/proposal.json`:
   ```json
   {
     "items": [
       { "type": "task", "title": "...", "quote": "...", "notes": "..." },
       { "type": "ddr", "title": "...", "quote": "..." },
       { "type": "artifact", "title": "...", "quote": "...", "artifactType": "user-flows" }
     ]
   }
   ```
   (`.forge/` is staging, not the record — writing here directly is fine.)

5. **Apply it:**
   ```bash
   forge intake apply <id>
   ```
   Add `--confirm` if step 1 printed quality warnings and you've reviewed them (a short
   transcript or one with timeline gaps is still worth classifying — you're just
   acknowledging the source might be incomplete). This writes `proposal.md` for human
   review and drops any item whose quote didn't verify — watch the command's output for
   `dropped an unverifiable item` and tell the user if anything you expected to survive
   didn't.

6. **Hand it back.** Tell the user what was staged and where to review it (the dashboard
   timeline, or `.forge/intake/<id>/proposal.md`) — you're done once the proposal is
   staged; accepting individual items into the record is a separate, human step.

7. **Run `forge doctor`** and fix anything it reports. This step only matters if something
   else in the record changed during this session — intake staging itself doesn't touch
   `decisions/`, the task ledger, or any other record file, so don't be surprised if there's
   nothing to fix.
