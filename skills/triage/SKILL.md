---
name: triage
description: Disposition a batch of staged stakeholder comments (accept → task, decline → DDR, defer) and apply them into the record. Use when the user asks to "triage comments", "triage feedback", or points you at comments staged under .forge/triage/.
---

# triage

Turns a freeze's stakeholder comments into `FEEDBACK-###` entries in the record, with a
real disposition for each one. This skill decides; `forge comments triage apply` is the
only thing that writes the record — it validates every task/DDR link before touching
anything, so a bad disposition fails loudly instead of writing something inconsistent.

This is a live, in-session disposition — different from (and complementary to) the
dashboard's async feedback-triage view: both write through the same CLI into the same
the same feedback entries, so it doesn't matter which one a comment goes through.

## Steps

1. **Stage the batch, if it isn't already.**
   ```bash
   forge comments triage <tag>
   ```
   This fetches unfetched comments for the freeze tagged `<tag>` and stages them at
   `.forge/triage/<tag>/comments.json`. If there's nothing to triage, it says so and stops
   — nothing further to do.

2. **Read the staged comments** and disposition each one:
   - `accepted` — this is real, actionable feedback. Either point it at an existing task
     (`taskId`) if one already covers it — this is where you de-duplicate: several
     near-identical comments can all resolve to the same task — or give it a `taskTitle`
     to create a new one.
   - `declined` — the feedback was heard and rejected on purpose. This *requires* an
     existing `DDR-###` explaining why (`ddrId`). If there isn't one yet, run the `ddr`
     skill first to capture that reasoning, then come back and reference its id — don't
     decline something without a decision backing it.
   - `deferred` — worth doing, not now.
   - `pending` — needs more thought before you can disposition it; leave it for a human to
     pick up later.

   Not every comment needs the same treatment — grouping duplicates under one task and
   giving a real disposition to each is the actual value of this skill over a raw dump of
   comments into the record.

3. **Write the proposal** to `.forge/triage/<tag>/proposal.json`:
   ```json
   {
     "items": [
       { "commentId": "...", "disposition": "accepted", "taskTitle": "Reduce header weight" },
       { "commentId": "...", "disposition": "accepted", "taskId": "TASK-042" },
       { "commentId": "...", "disposition": "declined", "ddrId": "DDR-051" },
       { "commentId": "...", "disposition": "deferred" }
     ]
   }
   ```
   Every staged comment should have an entry — one you skip becomes neither feedback nor a
   task, silently invisible to the rest of the record. If you genuinely don't know what to
   do with one, disposition it `pending` rather than leaving it out.

4. **Apply it:**
   ```bash
   forge comments triage apply <tag>
   ```
   This writes each item into the record's feedback (and a new or linked task into the task ledger for
   accepted items), then marks the comments fetched. It fails before writing anything if a
   `taskId`/`ddrId` you referenced doesn't actually exist — fix the proposal and rerun
   rather than guessing at a different id.

5. **Run `forge doctor`** and fix anything it reports.

6. **Tell the user what happened** — how many feedback items, how many new/linked tasks,
   and whether anything was skipped (the apply output reports this) — so they know what to
   review next.

## What the stakeholder sees afterwards

Each disposition is projected back onto the comment that caused it (DDR-064), so the share
link a stakeholder already has says where their point landed: declined ones carry the DDR,
and accepted ones read "addressed in `<tag>`" once the linked task is done and that release
is frozen. `forge freeze` runs the projection itself; `forge comments resolve <tag>` does
it on demand. Nothing here needs to be done by hand — but it is worth telling the user,
because it means a declined comment's DDR is text their stakeholder will actually read.
