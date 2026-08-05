---
name: forge-init
description: Set up the Forge Design Record for a project — usually an existing repo — by running `forge init` and then filling the brief, glossary, and open questions from what the project actually is. Use when the user asks to "set up Forge here", "adopt Forge", "start a Forge project", or points you at a repo that has no record yet.
---

# forge-init

Turns a repo into one Forge can work with: `forge init` lays down the core file set, then
this conversation fills it with content that is true about *this* project. The scaffold
without the conversation is the failure mode — spec §1 principle 3 exists because agents
read an unfilled template as truth.

**Adopting an existing repo is the normal case.** A project usually arrives with months of
history in a README, a changelog, scattered TODOs, and the code itself. Your job is mostly
to find what is already known and give it one home, not to interview the user about things
the repo can answer.

## Steps

1. **Find out what you're adopting.** Before running anything:
   - Is there already a record? `forge doctor` exits 2 with "not a Forge record" if not.
   - Is the repo on the **pre-v0.1 layout** (`todo/todo.md`, `context/brief.md`,
     `artifacts/glossary.md`)? Then this is a migration, not an init — use `forge upgrade`
     instead, and come back here to fill content afterwards.
   - Read what's there: README, CHANGELOG, any `PROJECT_STATUS`/`NOTES`/`TODOS` file,
     `package.json`, the main source directories. This is your raw material.

2. **Watch for a case collision.** On macOS and Windows a hand-written `TODOS.md` inside the
   bundle occupies the same path as the record's `todos.md` (likewise `Brief.md`). `forge
   init` refuses to create the record file in that case and warns you by name — don't
   ignore that warning, because the record is missing a core file until it's resolved. The
   fix is a rename, and the colliding file's *content* is usually exactly what the record
   wants: agree with the user on renaming it, then reuse what was in it in step 7.

3. **Scaffold:**
   ```bash
   forge init <path>
   ```
   Creates the OKF bundle: `design/index.md`, `design/brief.md`, `design/todos.md`,
   `design/decisions/DDR-000-template.md`, and `forge.json`; adds `.forge/` to `.gitignore`;
   registers the project; runs `git init` if needed. Existing files are never overwritten,
   so it is safe on a repo with work in it. Report exactly what it created versus kept.

   The bundle deliberately has no glossary or questions files yet: under v0.2 those are
   *directories* of one-concept-per-file, and they appear with their first concept.

4. **Fill `design/brief.md`.** What this is, who it's for, what it is deliberately *not*. Derive
   it from the repo and confirm with the user; write it in their language, not marketing
   copy. The "what it is not" section is the one people skip and the one that earns its
   keep — a non-goal is what stops a stakeholder's suggestion from silently becoming scope.

5. **Write the glossary** as `design/glossary/<term-slug>.md`, one file per term, each with
   `type: Term` frontmatter and a `title`. Terms that carry project meaning — the nouns in
   the codebase a newcomer would guess wrong. Pull them from the code's own vocabulary
   (type names, route names, domain objects), not from a generic list.

6. **Seed the open questions** with `forge question`, one call each:
   ```bash
   forge question "Can tier names change without legal review?" --context brief.md
   ```
   The command allocates the `QUESTION-###` and writes the concept, so you never pick an id.
   Only what you genuinely could not answer — questions the repo already answers do not
   belong here. If a "TODO: decide…" comment or an undecided design note exists in the
   project's docs, that is a question — lift it.

7. **Move real tasks into `design/todos.md`** if the project has a task list already, one
   `forge task add` per item:
   ```bash
   forge task add "Rebuild the pricing table" --genesis "changelog 0.2.0"
   ```
   Tasks stay one sectioned ledger inside that concept's body — they are the one thing v0.2
   does not split into files — and the command allocates the `TASK-###` from whatever the
   ledger already holds. `genesis` names what caused it; a dated source you can point at
   beats a link-shaped guess. **Reconcile duplicates as you go**: if the same item appears
   in two places, it gets one home, and the old file either points at the record or loses
   that section.

8. **Capture decisions already in force** with the `ddr` skill — one per non-obvious choice
   the project has already made and that a reader would otherwise reverse-engineer from the
   code. Don't manufacture these; three real ones beat a dozen invented.

9. **Run `forge doctor`** and fix what it reports. Last step, always.

## What not to do

- **Don't create files the project has no content for.** `design/feedback/`,
  `design/stakeholders/`, `design/roles/`, `design/data-model.md`, `design/flows/`,
  `design/calendar.md`, `design/design-system.md`, and
  `Components.md` are all on-demand: they appear the first time there is something true to
  put in them. An empty one is worse than a missing one.
- **Don't leave the scaffold's placeholder prose in place.** If you scaffold and stop, you
  have left rot behind. Either fill a file in this session or tell the user plainly that it
  is still a template.
- **Don't invent facts to fill a section.** If the repo doesn't say who the users are, that
  is a `QUESTION-###`, not a paragraph you write.
- **Don't guess `opened` dates or fabricate a `genesis`.** A dated source you can point at
  (`changelog 0.2.0`, `meeting 2026-05-06`) is worth more than a link-shaped guess.

## A note on writing files directly

Every other skill in this directory stages JSON and lets a `forge` command do the write,
because those files carry ids, enums, and links that need deterministic handling. This
skill writes the brief and the glossary terms directly, which is allowed: spec §2 says a record
file is "created the first time content exists for it — by a skill, the CLI, or a human",
and neither file has an entry grammar for a CLI to enforce.

The task ledger and the question concepts *do* carry ids, so those go through `forge task
add` and `forge question` — the id is allocated from what is already on disk, and a
duplicate is not a mistake you can make. Step 9 still matters, but it is now checking your
judgment rather than your bookkeeping.
