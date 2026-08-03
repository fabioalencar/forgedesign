# Forge process — Codex adapter

This file is the Codex-compatible restatement of the Claude Code skills in this directory
(`skills/forge-init/`, `skills/ddr/`, `skills/intake/`, `skills/triage/`, `skills/freeze/`). Same CLI commands,
same rules, same doctor-last discipline — just read as plain project context instead of an
invoked skill, since Codex doesn't have a skill-invocation mechanism. If a Claude Code
skill's instructions change, mirror the change here so the two never drift apart.

**The rule that applies everywhere below:** you never write into the record's tracked
files (the task ledger, feedback concepts, decisions, …) directly. You stage judgment as JSON
under `.forge/`, then a `forge` CLI command validates it and does the write. If a write you
need isn't covered by an existing command, say so rather than editing the record by hand.

**End every one of the workflows below by running `forge doctor` and fixing what it
reports.**

## Setting up the record (forge-init)

Use when asked to set up Forge in a repo, adopt Forge, or start a Forge project. Adopting an
**existing** repo is the normal case: most of what the record needs is already in the
README, changelog, scattered TODO files, and the code — find it rather than interviewing
the user for it.

1. Survey first. `forge doctor` exits 2 if there's no record yet. If the repo is on the
   pre-v0.1 layout (`todo/todo.md`, `context/brief.md`, `artifacts/glossary.md`), this is a
   migration — run `forge upgrade` instead, then fill content as below.
2. Watch for a case collision: on macOS/Windows a hand-written `TODOS.md` occupies the same
   path as `design/todos.md`. `forge init` refuses to create the record file and warns by name —
   the record is missing a core file until that is renamed, and the colliding file's content
   is usually what the record wants anyway.
3. `forge init <path>` — writes the OKF bundle: `design/index.md`, `design/brief.md`,
   `design/todos.md`, `design/decisions/DDR-000-template.md`, `forge.json`; gitignores
   `.forge/`; registers the
   project. Never overwrites. Report created-versus-kept.
4. Fill `design/brief.md` (what it is, who for, and what it is deliberately *not* — the
   non-goals are the part that earns its keep) and `design/glossary/<term>.md`, one file per
   term with `type: Term` frontmatter (terms from the code's own
   vocabulary, one line each), both derived from the repo and confirmed with the user.
5. Seed `design/questions/QUESTION-###.md`, one file each, with what you genuinely could not answer, as `QUESTION-###`
   entries. Lift undecided design notes and "TODO: decide…" comments — those are questions.
6. Move a real existing task list into `design/todos.md` with justifiable `opened` dates (a commit
   or changelog date, never today's date for months-old work) and a `genesis` you can point
   at. Reconcile duplicates: one fact, one home.
7. Capture already-in-force decisions through the ddr flow above. Three real ones beat a
   dozen invented.

Do not create the on-demand concepts (`design/feedback/`, `design/stakeholders/`, `design/roles/`,
`DataModel.md`, `ProcessFlows.md`, `Calendar.md`, `Design.md`, `Components.md`) — they
appear when there is something true to put in them. Do not leave scaffold placeholder prose
in place, and do not invent a fact to fill a section; an unknown is a `QUESTION-###`.

This is the one flow that writes record files directly, which spec §2 allows ("created …
by a skill, the CLI, or a human") — the brief and glossary terms have no entry grammar for
a CLI to enforce. The task ledger and question concepts do carry ids and there is no
`forge question apply`, so `forge doctor` at the end is the only thing catching a duplicate
id.

## Recording a decision

Use when you or the user make a non-obvious choice worth recording (library/pattern/
tradeoff pick, a scope cut, reversing an earlier decision), or the user asks to record one.
Skip routine, expected work — see CLAUDE.md rule 3.

1. Confirm the decision is actually settled before staging anything.
2. Write `.forge/ddr/<slug>.json`:
   `{ "title", "status" ("draft" unless the user explicitly signs off as final —
   never mark "accepted" on your own judgment), "contextSource", "decision", "why",
   "alternativesRejected"?, "consequences"? }`.
3. Run `forge ddr apply <slug>`. It allocates the next `DDR-###` id and writes
   `decisions/DDR-###-<slug>.md`. Fix and rerun on a validation error — never hand-edit the
   output file.
4. If this supersedes an earlier accepted DDR, change *only* that DDR's `Status` line to
   `superseded (by DDR-###)` — accepted DDRs are otherwise immutable (`forge doctor` rule 6
   enforces this).

## Classifying raw context (intake)

Use when asked to intake a transcript, meeting note, or other raw context.

1. Stage it if it isn't already: `forge intake <file>`. Note the printed id.
2. Read the staged copy at `.forge/intake/<id>/source-<name>` — classify from *that* copy,
   not the original file.
3. For each candidate worth surfacing, decide `type` (`task` | `ddr` | `artifact` — `ddr`
   stages a stub only, for the ddr flow above to fill in later), a `title` (≤120 chars),
   and a `quote` **copied verbatim, character-for-character, from the staged source** —
   `forge intake apply` silently drops any item whose quote isn't an exact substring, so
   don't paraphrase or fix typos in it. `artifactType` is required (and only used) for
   `type: "artifact"`: `user-flows`, `journey-maps`, `service-blueprints`, `site-audits`,
   `personas`, `competitive-analysis`, `user-stories`, `data-model`, `process-flow`.
4. Write `.forge/intake/<id>/proposal.json`: `{ "items": [{ "type", "title", "quote",
   "notes"?, "artifactType"? }] }`.
5. Run `forge intake apply <id>` (`--confirm` if step 1 printed quality warnings you've
   reviewed). Watch for `dropped an unverifiable item` in the output.
6. Tell the user what was staged and where to review it — accepting individual candidates
   into the record is a separate human step, not part of this flow.

## Dispositioning stakeholder feedback (triage)

Use when asked to triage comments for a freeze.

1. Stage: `forge comments triage <tag>`. If there's nothing to triage, stop.
2. For every staged comment, decide a disposition: `accepted` (link an existing task via
   `taskId` — this is how you de-duplicate several comments onto one task — or create one
   with `taskTitle`), `declined` (**requires an existing** `DDR-###` via `ddrId` — run the
   decision-recording flow above first if one doesn't exist yet; this command never
   fabricates a DDR), `deferred` (worth doing, not now), or `pending` (needs more thought).
   Every staged comment needs an entry — one you omit becomes invisible to the record.
3. Write `.forge/triage/<tag>/proposal.json`: `{ "items": [{ "commentId", "disposition",
   "taskId"?, "taskTitle"?, "ddrId"? }] }`.
4. Run `forge comments triage apply <tag>`. It fails before writing anything if a
   referenced `taskId`/`ddrId` doesn't exist — fix the proposal and rerun.
5. Report the counts back (feedback items, new/linked tasks, anything skipped).

## Cutting a release (freeze)

Use when asked to freeze, cut a release, or tag a version.

1. Confirm this is a coherent, reviewable slice of work, not just a passing thought.
2. Check `freezes.json`'s most recent entry, then skim the task ledger's `## Done` section,
   resolved feedback entries, and newly-accepted DDRs since then. Draft a short
   "what shipped and why" message for a stakeholder — not a raw task-title dump.
3. Pick a short sequential tag name (`alpha`, `beta`, `v0.3`) if the user hasn't given one.
4. Make sure the working tree is clean — `forge freeze` refuses otherwise. Commit any
   pending record changes first.
5. Run `forge freeze <tag> --message "<the message from step 2>"`. Freeze produces the
   artifact; it does not host it. To put it in front of a stakeholder, follow with
   `forge publish <tag>` (DDR-073).
6. Report back the preview/Storybook URLs, stakeholder PIN, and handoff pack location
   verbatim from the command's output.

`FeatureLog.md` generation isn't wired into `forge freeze` yet — don't tell the user one
was generated (see `todo/todo.md`'s T-238).
