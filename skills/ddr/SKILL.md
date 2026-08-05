---
name: ddr
description: Capture a design decision made mid-session into decisions/ as a new DDR. Use when you (or the user) make a non-obvious choice worth recording — a library, pattern, or tradeoff pick, a scope cut, a reversal of an earlier decision — or when the user explicitly asks to "write a DDR" / "record this decision".
---

# ddr

Records one decision as a `DDR-###-slug.md` concept in the record's `decisions/`. This skill is conversation and
judgment only — it never writes into `decisions/` directly. `forge ddr apply` does that
write, so the id allocation and file shape stay deterministic and consistent no matter
which agent runs this skill.

## When to use this

Per this repo's own rule (CLAUDE.md #3): a DDR is for a *non-obvious* choice — something a
future reader would otherwise have to reverse-engineer from the diff. Routine, expected
implementation work doesn't need one. If you're unsure whether a choice is DDR-worthy, ask
the user rather than skipping it or writing one reflexively.

## Steps

1. **Confirm the decision is settled.** If the user is still weighing options, don't stage
   a DDR yet — keep discussing until there's an actual decision to record.

2. **Draft the content:**
   - `title` — short, specific (e.g. "Pivot: Forge is the design record, not the build
     tool", not "Pivot").
   - `slug` — lowercase, hyphenated, derived from the title (e.g. `pivot-design-record`).
   - `status` — `draft` unless the user has explicitly signed off on it as final, in which
     case `accepted`. Never write `accepted` on your own judgment alone.
   - `date` — when the decision was actually made, `YYYY-MM-DD`. Omit it for a decision made
     now; set it when back-filling history, which is the case a default of "today" gets
     wrong on every entry.
   - `contextSource` — what triggered this (a meeting, a transcript, this conversation, an
     exploration branch). Be specific enough that someone reading it in six months knows
     where to go for more detail.
   - `decision` — one paragraph, plainly stating what was decided.
   - `why` — the forces at play and the reasoning. This is the part that actually earns a
     DDR instead of a commit message; don't skip it.
   - `alternativesRejected` (optional but usually worth including) — what else was
     considered and why it lost.
   - `consequences` (optional) — what this makes easier, what it makes harder, what it
     commits the project to.

3. **Stage it.** Write the draft as JSON to `.forge/ddr/<slug>.json` in the record root:
   ```json
   {
     "title": "...",
     "status": "draft",
     "date": "2026-05-06",
     "contextSource": "...",
     "decision": "...",
     "why": "...",
     "alternativesRejected": "...",
     "consequences": "..."
   }
   ```
   (`.forge/` is staging, not the record — writing here directly is fine.)

4. **Apply it:**
   ```bash
   forge ddr apply <slug>
   ```
   This allocates the next `DDR-###` id (scanning `decisions/` for the current max — ids
   are never reused or renumbered) and writes `DDR-###-<slug>.md` into the record's decisions folder. It fails with
   a clear error if a required field is missing or `status` isn't `draft`/`accepted`/
   `superseded (by DDR-###)` — fix the staged JSON and rerun rather than hand-editing the
   output file.

5. **Run `forge doctor`** and fix anything it reports. This is the last step of every
   skill — don't skip it because the apply step succeeded.

6. **Changing an earlier decision: say which, and which way.** Accepted DDRs are immutable
   content-wise (`forge doctor` enforces this), so an earlier decision is never rewritten.
   There are two ways to change one and they are different facts:

   - **Replaced wholesale** — the older DDR's `decision_status` becomes `superseded` with a
     `superseded_by` link. Only that changes; never rewrite its body.
   - **Part of it changed, the rest still stands** — the far more common case. The older DDR
     keeps `decision_status: accepted` and gains `amended_by: [DDR-###]`, which is the one
     edit the immutability rule permits. Put `"amends": ["DDR-###"]` in the staged
     JSON so the new decision declares it too: `forge doctor` checks that both halves agree,
     and it reads that key rather than your prose, so writing "this amends DDR-###" in the
     body alone records nothing.

   Reach for `superseded` only when nothing in the older decision still holds. Marking an
   amendment as superseded asserts something false about the parts still in force.
