---
name: review
description: Evaluate a built prototype against the record using the four-vector review rubric, and file the findings as feedback. Use when the user asks to "review the prototype", "run the rubric", "check this against the brief", or wants to know whether what was built serves what the record says it is for.
---

# review

Runs the four-vector rubric (DDR-108) over a built prototype **against the record**, and
files what it finds as `source: scan` feedback. This skill judges; `forge review apply` is
the only thing that writes the record.

**Advisory, never blocking.** Nothing here stops a freeze, and findings land `pending` —
dispositioning them is the human's act. A scan that dispositioned its own findings would be
a gate, and the gate is Forge Cloud's (DDR-057). This is the free surface of the same
rubric (DDR-112): the whole rubric runs here, on whatever model this session has.

**Say plainly what that costs.** The findings are only as good as this session's model and
the time it spent looking. When you report back, say what you did *not* check — routes you
did not open, scenarios you did not run, vectors you could only answer from the record. A
finding you missed is not a finding the record may later claim was checked.

## The rubric evaluates against the record, never against pixels alone

That is the whole point of running it here rather than in a linter. Each vector has ground
truth in the record, and a finding without ground truth is an opinion:

1. **Utility & problem fit** — does this remove the friction the record names, for the job
   the record names, without adding cognitive debt? Ground truth: `design/brief.md`,
   `design/stories/`, `design/questions/`, each task's `genesis:`, and each scenario's
   Purpose and Expected outcome.
2. **Systemic & technical coherence** — is it built in the system's own language? Ground
   truth: `design/design-system.md`, `design/components.md`, `tokens/tokens.json`, and the
   prototype contract (DDR-072). The most deterministic vector: token adherence against the
   built CSS, rendered components against the inventory, axe-core for WCAG.
3. **Information architecture & hierarchy** — can a reviewer scan a screen and find the
   primary action? Per route, and per scenario step where there are scenarios.
4. **Business viability** — does each step's primary action serve the loop the brief names?
   Ground truth: the brief's business framing, `design/roles/` (who converts),
   `design/flows/`. Judgment, never deterministic.

**A finding is feedback, not a score.** Never produce a number, a grade, or a pass/fail.
The record cannot back that objectivity, and an aggregate moves the judgment the human owns
into something nobody can argue with.

## Start with the preconditions, because they are findings

Before opening the prototype, read the record for the ground truth each vector needs. What
is missing **is a vector-1 finding**, and it needs no screenshots:

- a brief that names no friction it removes, or no loop it drives — the two sections the
  `forge-init` skill asks for rather than infers, precisely because a repo cannot supply
  them
- a scenario with no Purpose or no Expected outcome, so nothing can say whether working
  through it succeeded
- tasks with no `genesis:`, so what was built cannot be traced to what asked for it

Report these first. A review of a prototype whose record states no job is a review that can
only comment on taste, and saying so is more useful than a list of spacing notes.

## Steps

1. **Read the record.** Brief, stories, questions, scenarios, design-system, components,
   roles, flows — whichever exist. Note what is absent; that is step 4's material.

2. **Walk the prototype.** Build it if it is not built, then open the routes the record
   names — a scenario's `## Flow` steps are the itinerary when there are scenarios, because
   they are what a real reviewer will be asked to do. For vector 2, prefer the deterministic
   checks: compare the built CSS against the tokens, the rendered components against the
   inventory, and run axe-core where you can.

3. **Judge each vector against its ground truth.** For every finding, be able to name the
   record's own words it is measured against. If you cannot, it is an opinion — either drop
   it or file it as a vector-1 finding about the record not saying.

4. **Stage the findings** at `.forge/review/findings.json`:
   ```json
   {
     "findings": [
       {
         "vector": "utility",
         "finding": "The brief names no friction, so nothing here can be judged against a job.",
         "title": "The brief names no friction it removes"
       },
       {
         "vector": "coherence",
         "finding": "The sign-in button hardcodes #4A9EDE rather than using the token.",
         "route": "/",
         "selector": "button.primary"
       },
       {
         "vector": "hierarchy",
         "finding": "Two controls compete for primary on the review step.",
         "scenario": "SCENARIO-002",
         "step": "s2"
       }
     ]
   }
   ```
   `vector` is one of `utility | coherence | hierarchy | viability` and is required.
   `finding` is required and becomes the entry's blockquote. `title` is optional — one line,
   derived from the finding when absent. `route`, `selector`, `scenario` and `step` are
   optional context; `step` needs the `scenario` it belongs to, and a `scenario` id that the
   record does not have is refused.

5. **Apply it:**
   ```bash
   forge review apply
   ```
   It validates every finding before writing any of them, allocates a `FEEDBACK-###` each,
   writes them as `source: scan` with `feedback_status: pending`, and consumes the staged
   file so a second run cannot file the same review twice. Fix the JSON and rerun on a
   validation error rather than hand-editing what it wrote.

6. **Run `forge doctor`** and fix anything it reports.

7. **Tell the user what you found and what you did not look at** — counts by vector, the
   preconditions that were missing, and the honest gaps from the note at the top. Then stop:
   dispositioning is theirs.

## What happens to the findings afterwards

They are feedback like any other, so they flow through the machinery the record already
has: accepted links a `TASK-###`, declined requires a `DDR-###` recording why, deferred and
pending wait. Nothing about a scan finding is privileged — a human can decline the whole
batch, and that is a legitimate outcome rather than a failure of the review.
