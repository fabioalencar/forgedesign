---
name: freeze
description: Gather release notes conversationally and run forge freeze to tag, build, and (optionally) deploy an immutable version for stakeholder review. Use when the user asks to "freeze", "cut a release", "tag a version", or wants to put the current state in front of a stakeholder.
---

# freeze

Freezes are immutable version snapshots (spec/format.md; DDR-032): an annotated Git tag,
a prototype + Storybook build, immutable preview URLs, a stakeholder PIN, a handoff pack,
and a `freezes.json` entry. `forge freeze` does all of that — this skill's job is making
sure the tag actually tells the story of what changed, not just stamping a version number.

## Steps

1. **Confirm this is really a freeze moment.** A freeze is meant to be a coherent,
   reviewable slice of work — not every commit. If the user's just thinking out loud,
   keep talking instead of jumping to `forge freeze`.

2. **Look at what's actually changed since the last freeze.** Check `freezes.json` for the
   most recent entry's date/commit, then skim:
   - the task ledger's `## Done` section for tasks closed since then.
   - the record's feedback for anything resolved (accepted → shipped, declined → recorded why).
   - `decisions/` for DDRs accepted since then.
   Don't just list task titles back at the user — that's what `git log` is for. Draft a
   short "what shipped and why it matters" summary a stakeholder (not another engineer)
   would actually read.

3. **Pick the tag.** A short, sequential, human name — `alpha`, `beta`, `mvp`, `v0.3` — not
   a date or a commit hash. Ask the user if it's not obvious from context.

4. **Make sure the working tree is clean.** `forge freeze` refuses to run otherwise (freezes
   are immutable, so nothing can be silently left out). If the feedback, tasks, or decisions
   changes from earlier in this session (or anyone else's) aren't committed yet, commit them
   first — don't freeze over uncommitted record changes.

5. **Run it:**
   ```bash
   forge freeze <tag> --message "<the summary from step 2>"
   ```
   Freeze produces the artifact; it does not host it (DDR-073). If the user wants a
   stakeholder to see it, follow with `forge publish <tag>`, which prints the review URL.

6. **Report back** exactly what the command printed: the review URL if you published, the
   stakeholder PIN, and where the handoff pack landed. Don't paraphrase the URLs — copy
   them verbatim so the user can hand them off directly.

   Two things the freeze does quietly that are worth mentioning when they apply:
   - **Scenarios ride along.** Any `SCENARIO-###` in the record is emitted into the build,
     so the reviewer gets a scenario selector, and a scenario with `## Flow` steps turns
     the review into a guided pass — their comments record which step they were on.
     If the record has no scenarios, review is unguided; if that matters
     for this release, say so rather than letting the user find out from a stakeholder.
   - **Old share links update themselves.** Comments whose feedback shipped in this release
     now read "addressed in `<tag>`" on the preview the stakeholder already has (DDR-064).
     If the command reported any, tell the user — it is often worth a note to the person
     who raised them.

7. **Run `forge doctor`** and fix anything it reports.

## The feature log

`forge freeze` writes `design/feature-log.md`: one section per freeze, each listing what
reached Done since the freeze before it. "Closed since" is read from Git by comparing the
task ledger at consecutive tags — a task carries `opened` and a `status`, never a closed
date — so the whole file is regenerated from the tags each freeze rather than appended to.

It carries a `generated:` key and a "do not edit" line for anyone reading it raw. Both are
load-bearing: `forge doctor` fails a derived file that has been hand-edited.
