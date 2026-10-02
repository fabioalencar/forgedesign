# The Design Record format — v0.2

> Status: draft (accepted direction per DDR-050; OKF conformance per DDR-055; profile
> details per DDR-060). This file is the public, tool-agnostic specification of the
> Markdown file set Forge scaffolds, validates, renders, and freezes. The CLI is the
> reference implementation; any agent or editor that follows this spec is a first-class
> citizen.
>
> **v0.2 is the OKF profile for product design.** The record is a conformant
> [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
> bundle (OKF v0.2). Everything OKF requires, this format requires; everything else here
> is a Forge profile on top of it — a fixed directory layout, a type vocabulary, stable
> IDs, and a validator. An OKF-aware agent or catalog reads a Design Record with no Forge
> tooling installed.
>
> Two different version numbers appear in this document and they are not the same thing:
> `forge.json#formatVersion` (`0.2`) is *this* spec's version; `okf_version` (`0.2`) is the
> OKF spec's version. They coincide today by accident, not by rule.

## 1. Principles

1. **Truth lives in the repo** (DDR-001). The record is plain files under Git. No database
   of record, no sidecar state. Anything a tool renders is a projection of these files;
   anything a tool edits writes back through this format.
2. **Every fact has exactly one home.** Other files link to it by ID. A deadline lives in
   `calendar.md`; the decision it references lives in `decisions/`; neither restates the
   other.
3. **Progressive scaffolding.** `forge init` creates the core set only — the index, the
   brief, the task ledger, and the template decision. Every other file is created the first
   time content exists for it, by a skill, the CLI, or a human. Empty templates are rot, and
   agents read rot as truth; a directory of concepts with no concepts in it is not even a
   thing Git can record.
4. **Human-written vs derived is explicit.** Derived files declare `generated` in
   frontmatter and are never hand-edited; `forge doctor` flags manual edits to them.
5. **Plain CommonMark + tables.** The record must render acceptably in GitHub, Obsidian, or
   any Markdown viewer with zero Forge tooling installed.
6. **Aggregation is a projection, never a file** (DDR-059). A concept is one file; the
   board, the feedback stream, the glossary index, and the timeline are computed at read
   time by whatever consumes the bundle. The only aggregation stored in the repo is a
   `generated` file.

## 2. The bundle

The record is an OKF bundle rooted at **`design/`** — a subdirectory, never the repo root.
This is forced by OKF conformance: *every* non-reserved `.md` file in a bundle tree must
carry frontmatter, and a real project repo always has a `README.md`, a `CHANGELOG.md`, or
an `AGENTS.md` that will not. The bundle is therefore also a clean unit to tar, publish, or
hand to an agent on its own.

**What crosses at publish** (DDR-129). `forge publish <tag>` sends two things beside each
other: the frozen build, and a snapshot of this bundle filtered to the concepts whose
`audience` is `stakeholders` (§3), read from the tag rather than the working tree.
`index.md` is regenerated over what crossed; `log.md`, the template decision and every
owner-only concept stay home. The snapshot is a private blob the review runtime alone
reads. It is a copy the creator chose, at a version — the repository remains the record.

```
design/
  index.md                     OKF index; the only file carrying okf_version
  log.md                       OKF change history (optional, any directory)
  brief.md                     type: Brief
  todos.md                     type: Task Ledger          TASK-###
  calendar.md                  type: Calendar
  data-model.md                type: Data Model
  design-system.md             type: Design System
  components.md                type: Component Inventory
  pages.md                     type: Page Manifest        (optional)
  feature-log.md               type: Feature Log          (generated)
  decisions/DDR-###-slug.md    type: Decision             DDR-###
  feedback/FEEDBACK-###.md     type: Feedback             FEEDBACK-###
  questions/QUESTION-###.md    type: Question             QUESTION-###
  stories/STORY-###.md         type: Story                STORY-###
  roles/ROLE-###.md            type: Role                 ROLE-###
  stakeholders/STAKEHOLDER-###.md  type: Stakeholder      STAKEHOLDER-###
  glossary/<term-slug>.md      type: Term
  flows/FLOW-###.md            type: Flow                 FLOW-###
  scenarios/SCENARIO-###.md    type: Scenario             SCENARIO-###
  checks/<tag>/<checker>.md    type: Check                (generated)
```

| Path | Purpose | Created |
|---|---|---|
| `design/index.md` | OKF index for progressive disclosure; declares `okf_version` | init |
| `design/brief.md` | Genesis requirements and definitions the project started from | init |
| `design/todos.md` | Tasks with status, dates, and genesis (what caused them) | init |
| `design/decisions/` | One file per decision, with rationale and alternatives | init (holds the template DDR) |
| `design/glossary/` | One file per term that carries project meaning | on demand (`forge add`) |
| `design/questions/` | Unresolved questions to explore with stakeholders | on demand (`forge question`) |
| `design/feedback/` | Every piece of feedback from every source, with disposition | on demand (`forge comments triage apply`) |
| `design/stakeholders/` | Minimal stakeholder profiles and their contributions | on demand (`forge add`) |
| `design/stories/` | User stories introduced along the iterations | on demand (`forge add`) |
| `design/roles/` | Role assumptions; seeds the role switcher on hosted reviews | on demand (`forge add`) |
| `design/flows/` | End-to-end process flows (Mermaid, DDR-056) | on demand (`forge add`) |
| `design/scenarios/` | What the prototype runs under for one review: role, permissions, flags, route rules, dataset, review flow (DDR-063) | on demand (`forge add`) |
| `design/data-model.md` | Entities, shapes, enums, relationships, business rules observed in the prototype — what the data *is*, not how to serve it | on demand (`forge add`) |
| `design/calendar.md` | Deadlines, checkpoints, timeline; references decisions and freezes by ID | on demand (`forge add`) |
| `design/design-system.md` | Design tokens and brand direction; links `components.md` | on demand (`forge add`) |
| `design/components.md` | Component inventory | on demand (`forge add`) |
| `design/pages.md` | Which pages the prototype has: a route, a title, and the flows and stories that touch it — declared intent beside the derived Screens section (DDR-130) | on demand (`forge add`) |
| `design/feature-log.md` | Features closed per freeze | **generated** (at freeze) |
| `design/checks/` | One report per checker per version — what a checker found, at which commit (DDR-127) | **generated** (`forge check`) |

**Outside the bundle**, at the repo root: `forge.json` (project manifest, carries
`formatVersion`, `recordRoot`, and the `build` block — `{ "command", "output", "dir"?,
"storybook"? }` — that tells `forge freeze` how this project builds and where the build
lands, and `checks`, the checkers `forge check` runs — DDR-127), `freezes.json`
(machine-readable freeze registry, `FREEZE-###`; each entry carries
`routes`, the content hash of every built route, from which the feature log derives which
screens changed — DDR-121), `datasets/`, `tokens/tokens.json` (DTCG). These are the executable layer —
machine contracts, not knowledge concepts — and OKF constrains only `.md` files. Scenarios
are *not* among them: a scenario is authored as a concept and its runtime JSON is emitted
at build time (DDR-063).

**Concepts vs ledgers.** A fact that other files link *to* is a concept file: it earns a
concept ID, its own frontmatter, and a stable link target. A fact that is only ever read in
bulk, in order, is a ledger: one file whose body is a list. `todos.md` is the only ledger,
because a task's identity is its position in a workflow, its volume is an order of
magnitude above everything else, and agents read the whole list every session (DDR-060).

**Reserved filenames.** OKF reserves `index.md` and `log.md` at every level; they must not
be used for concepts. `index.md` carries no frontmatter, except the bundle root's, which
may carry only `okf_version`. `log.md` carries no frontmatter and is a flat, newest-first
list of dated entries. Note `feature-log.md` is a normal concept and deliberately *not*
named `log.md`.

**The bundle-root index is derived, and says so in its body.** `forge index` regenerates it
from the concepts on disk, and the writers that add a concept regenerate it too. Because
OKF permits only `okf_version` in an index's frontmatter, it cannot carry the `generated`
key every other derived file uses; the marker is instead the first line of the body:
`<!-- generated by forge index · do not edit -->`. Doctor rebuilds the index and compares,
so a hand-added concept surfaces as a stale index rather than silently going unlisted. An
index *without* that marker is somebody's own writing and is left alone — the index is
optional for conformance, and OKF consumers may synthesize one anyway.

## 3. Frontmatter

Every concept file opens with a YAML block. OKF requires exactly one key, `type`; the rest
is this profile.

```yaml
---
type: Feedback                       # REQUIRED (OKF)
id: FEEDBACK-011                     # REQUIRED for ID-bearing types (Forge)
title: Enterprise column reads as an afterthought
description: Pricing table feedback from the 2026-07-18 review
date: 2026-07-18
status: stable                       # OKF lifecycle: draft | stable | deprecated
feedback_status: accepted            # Forge domain state (see below)
sources:
  - resource: /design/stakeholders/STAKEHOLDER-002.md
generated: { by: forge-cli/0.2.0, at: 2026-07-18T10:12:00Z }   # derived files only
---
```

- `type` — from the vocabulary in §2. OKF type values are free-form and uncentralized;
  this profile fixes them so a consumer can route on them.
- `id` — the `PREFIX-NNN` identifier, required on every ID-bearing type and identical to
  the one in the filename. Redundant on purpose: the filename makes it greppable and gives
  OKF a meaningful concept ID, the field makes it machine-readable without path parsing.
- `title`, `description` — OKF-recommended. `description` is what an `index.md` generator
  and the renderer's list views show.
- `date` — when the concept came into being (a decision's date, a feedback's arrival).
- `audience` — who may see this concept once the record is published: `owner` or
  `stakeholders` (DDR-128). Optional, with a default per type: `stakeholders` for the brief,
  flows, the data model, design system, component inventory, glossary, stories, roles,
  scenarios, calendar, questions and the page manifest; `owner` for the task ledger, stakeholders, feedback,
  decisions, the feature log and check reports. A decision is owner-only until the creator
  flips it, because it carries the alternatives it beat. Doctor checks the value; nothing
  owner-only crosses at publish, and the release hub renders only what stakeholders may see.
- `sources` — OKF provenance: what this concept derives from. Replaces v0.1's `source:`
  convention; each entry carries a `resource` (a bundle-relative path or a URL).
- `generated` — `{ by, at }` per OKF's actor convention. **Its presence is what makes a
  file derived** (principle 4). Hand-authored concepts omit it.
- `verified` — optional `{ by, at }` (or a list). `by: human:<id>` marks human-reviewed
  content; reserved for future use by the renderer and Cloud review.

### Status: two fields, on purpose

OKF defines `status` as document lifecycle with the enum `draft | stable | deprecated`,
and consumers derive staleness from it. Forge's domain states are different questions
entirely (is this decision accepted? is this feedback declined?), so overloading `status`
would hand a generic OKF consumer a value it must read as malformed. The profile therefore
keeps `status` OKF-pure and gives each type its own domain field (DDR-060):

| Type | Domain field | Values |
|---|---|---|
| Decision | `decision_status` | `draft \| accepted \| superseded` |
| Feedback | `feedback_status` | `pending \| accepted \| declined \| deferred \| done` |
| Question | `question_status` | `open \| resolved \| dropped` |
| Task (ledger row) | `status:` in the row | `todo \| doing \| done \| deferred` |

`status` itself is optional and defaults to `stable`; write it only when a concept is a
`draft` or has been `deprecated` as a document.

## 4. IDs

- Format: `PREFIX-NNN` — descriptive uppercase prefix, dash, zero-padded number
  (`TASK-001`, `FEEDBACK-012`, `DDR-050`).
- IDs are immutable and never reused, including for deleted/declined entries.
- Numbering is per-prefix, monotonically increasing, assigned at creation.
- Prefixes are reserved: `TASK`, `DDR`, `FEEDBACK`, `STAKEHOLDER`, `STORY`, `QUESTION`,
  `ROLE`, `FLOW`, `FREEZE`, `SCENARIO`.
- **The filename carries the ID verbatim** for ID-bearing types, so OKF's concept ID (the
  path minus `.md`) is stable and self-describing: `design/feedback/FEEDBACK-011`.
  Decisions keep their slug suffix (`DDR-050-pivot-design-record.md`) because a decision's
  title is load-bearing when browsing a folder.
- Files without an ID prefix (terms) are named by kebab-case slug of the concept:
  `design/glossary/design-record.md`.
- Naming rule: ID-bearing files use the ID's own casing; everything else is lowercase
  kebab-case. Doctor rejects any file that differs from an expected name only by case.

## 5. Entry shapes

### design/todos.md (the one ledger)

````markdown
---
type: Task Ledger
title: Todos
---

## Doing
- [ ] TASK-042 Rebuild the pricing table for the enterprise tier
  status: doing · opened: 2026-07-20
  phase: Phase 12 — Pricing surfaces
  genesis: FEEDBACK-011
  notes: blocked on QUESTION-004 (legal review of tier names)
````

Sections: `## Todo`, `## Doing`, `## Done`, `## Deferred`. Statuses:
`todo | doing | done | deferred`. `genesis` names what caused the task: a `FEEDBACK-###`,
`QUESTION-###`, `DDR-###`, or a dated source (`meeting 2026-07-18`). `phase` is optional
free text naming the arc a task belongs to — the sections are statuses, so a project that
groups work into phases carries the grouping on the row (DDR-068); rows are in the same
phase when they say the same thing, and nothing validates the value. Done tasks keep their
ID forever.

### design/feedback/FEEDBACK-###.md

```markdown
---
type: Feedback
id: FEEDBACK-011
title: The enterprise column reads like an afterthought
date: 2026-07-18
feedback_status: accepted
source: meeting
from: STAKEHOLDER-002
resolution: TASK-042
---

> The enterprise column reads like an afterthought.
```

Sources: `meeting | email | chat | review | scan | figma | issue` (`review` = comment on a
hosted freeze, which also carries `freeze: FREEZE-003`; `scan` = automated check finding;
`figma` = a comment on a Figma file and `issue` = an issue in a tracker, both staged by
`forge comments import` and carrying `url`, where the comment lives at its source — DDR-124).
`resolution` links the outcome: `accepted` links the resulting `TASK-###`; `declined` links
the `DDR-###` recording why (declining feedback is a decision); `done` means the linked work
shipped in a freeze. The body holds the feedback verbatim, as a blockquote.

Review-sourced feedback carries two more fields, which are what let the record tell the
person who wrote the comment what became of it (DDR-064):

- `comment` — the comment id in the hosted service, written by `forge comments triage
  apply`. Opaque to the record; it exists so a disposition can be projected back.
- `addressed_in` — the freeze tag whose release shipped the accepted work, stamped by
  `forge comments resolve <tag>` when the linked `TASK-###` is `done`. Its presence is what
  makes `feedback_status: done` mean a specific release rather than a vague past.

Feedback from a **guided** review — one where the reviewer worked through a scenario's flow
— also carries `scenario: SCENARIO-002` and `step: s2` (DDR-063's flow steps). They record
what the reviewer was doing when they wrote it, which is what separates "this broke while
approving" from "this broke".

Feedback from a **scan** carries `vector`, naming which of the review rubric's four lenses
produced it: `utility | coherence | hierarchy | viability` (DDR-108). It is written by
`forge review apply` and always lands `pending` — a scan reports, a human dispositions, and
one that dispositioned its own findings would be a gate rather than a review. Scan feedback
may carry `route`, `selector`, `scenario` and `step` for the same reason review feedback
does: where and while doing what. It never carries a score; the rubric produces arguable
findings, not a grade.

### design/decisions/DDR-###-slug.md

```markdown
---
type: Decision
id: DDR-050
title: "Forge is the design record, not the build tool"
date: 2026-07-23
decision_status: accepted
reach: project
sources:
  - resource: /design/calendar.md
---

## Decision
## Why
## Alternatives rejected
## Consequences
```

A decision says how far it reaches. `reach: project | general` is optional and defaults to
`project`: the decision is about this product — its users, its brand, a constraint of this
client. `general` marks one that would hold on a project with a different client: house
style, a standing practice, a rule the author would carry to the next repo. The test is two
questions, asked once when the decision is staged: does the *why* name this project's
users, brand, or constraint? Would the decision hold on a different project? Both true
means `project` now; it earns `general` when it recurs. Doctor checks the value and nothing
in Forge reads it further, which is the point — a developer inheriting the repo can tell
house style from this-project-only without reading every *why*, and a downstream reader
that ranks or collects decisions across projects has a machine-readable hook without the
format learning that reader's name (DDR-119).

Accepted decisions are immutable. A later decision changes an earlier one in one of two
ways, and they are different facts:

- **Superseded** — replaced wholesale. The original gets `decision_status: superseded` and
  `superseded_by: DDR-###`.
- **Amended** — part of it changed, the rest still stands. The original keeps
  `decision_status: accepted` and gains `amended_by: [DDR-###, …]`, and the decision making
  the change declares `amends: [DDR-###, …]` in its own frontmatter.

Most real changes are amendments, and marking one `superseded` would assert something false
about the parts still in force. Adding `amended_by` to an accepted decision is the one edit
the immutability rule permits (DDR-087); everything else in the file must still match.

`amends` is written when the decision is written, and it is what makes the pair checkable:
`forge doctor` requires every decision named there to carry the matching `amended_by`
(DDR-090). It reads the declared key and never the prose, because a decision that *describes*
other decisions' amendments is indistinguishable from one that makes them.

### design/questions/QUESTION-###.md

```markdown
---
type: Question
id: QUESTION-004
title: Can tier names change without legal review?
date: 2026-07-19
question_status: open
---
```

Resolution sets `question_status: resolved` and `resolution: DDR-047` (or a `FEEDBACK`/
`TASK` id). Together with `brief.md`, these files feed the CSD-matrix view: certainties
come from the brief, suppositions and doubts live here.

A question a stakeholder raised in a hosted review carries the provenance review feedback
carries — `source: review`, `freeze`, `from`, `comment`, `route`, `selector`, and
`scenario`/`step` when guided — and its body is the question verbatim, as a blockquote. It
is written by `forge comments triage apply` from a comment the reviewer marked as a
question (DDR-122): `answered` at triage is `question_status: resolved` with `resolution`
naming what answers it; `open` is `open`; `declined` is `dropped` with the `DDR-###` that
declines it. The service is told the outcome the way it is told feedback's, by id and
title; the answer's own text stays in the record.

### design/stakeholders/, design/roles/, design/stories/

One concept per file: `id`, `title` as the one-line identity, dated fields, links out.
`roles/` entries additionally declare what the role can see/do in the prototype — these
(with `data-model.md`) are **runtime inputs**: they seed the scenario/role switcher on
hosted reviews, so keeping them true has a visible payoff.

A role declares its capabilities in a `permissions:` frontmatter list, which is the
mechanism the runtime reads:

```markdown
---
type: Role
id: ROLE-002
title: Approving manager
permissions: [orders.view, orders.approve]
---
```

These are the role's own; a scenario composes on top of them rather than restating them
(see the scenario section below for the `role` link and the `+`/`-` composition rule).

### design/flows/FLOW-###.md and design/data-model.md

Diagrams are Mermaid, always (DDR-056). A flow's body carries a `flowchart`; the data
model's carries an `erDiagram` plus the entity/field/rule prose around it. No other
diagram format appears in the record.

### design/scenarios/SCENARIO-###.md

```markdown
---
type: Scenario
id: SCENARIO-004
title: Manager approving a pending order
role: ROLE-002
permissions: [orders.approve]
flags: { newCheckout: true }
routes:
  hidden: ["/admin/**"]
  redirect: { "/": "/dashboard" }
dataset: orders-busy-week
route: /orders?f=pending
viewport: 1280x800
version: 3
---

## Purpose
## Expected outcome

## Flow
- s1 · Open pending orders · /orders?f=pending
- s2 · Approve the flagged one · /orders/1182
```

One artifact serves both directions (DDR-063): captured from a working preview, or declared
before the prototype exists so an agent can build against it. Saved scenarios version by
addition, never by silent mutation; a pin cites `SCENARIO-###@<version>` beside a Git
commit.

**Permissions compose *on top of* the role — the scenario does not restate what the role
already grants.** `role` links a `ROLE-###`, and the linked role's `permissions:` are the
base set; the role concept owns that fact rather than the scenario duplicating it. On top
of that base, a scenario's own `permissions` are **added**, and an entry prefixed with `-`
**removes** one — so the effective set is the role's list plus the scenario's additions
minus its removals:

```yaml
role: ROLE-002                              # grants orders.view, orders.approve
permissions: [orders.export, -orders.approve]   # effective: orders.export, orders.view
```

One field expresses both directions, so a degraded state ("a manager who cannot approve")
is reviewable without duplicating the role. Removing a permission the role does not grant
is reported rather than ignored: it usually means the role changed underneath the scenario.

**The review flow** lives in the body under a `## Flow` heading, one step per line as
`- <id> · <label> · <route>` (the route is optional). The overlay renders these as a
checklist and binds a comment to version + scenario + step.

The scenario set is emitted as JSON into a built prototype, where a small runtime reads
`?scenario=` and exposes `can()`, `flag()`, `data`, and a route guard. That JSON is derived
— the markdown is the source, and it is never hand-edited.

### design/calendar.md

Dated rows referencing IDs — never restating them:

```markdown
- 2026-08-01 · checkpoint: stakeholder review of FREEZE-004 (STAKEHOLDER-002)
- 2026-08-15 · deadline: dev handoff — gated on DDR-053
```

### design/pages.md (optional)

One row per page the prototype has, keyed by the route the build serves it at — the same
identity `freezes.json#routes` records and a feedback's `route` carries (DDR-130):

```markdown
- / · Home — FLOW-001, STORY-002
- /register · Sign up — FLOW-001, STORY-003, TASK-042
- /forgot-password · Forgot password
```

The route is root-relative; `/register/` and `/register` are one page. The title is the
text up to the first ` — `; every ID on the row is something that touches the page — a
flow, a story, a task — referenced, never restated. A row is declared *intent*: which
screens **changed** is derived from the build (DDR-121), and the feature log prints the
intent beside the derived status. A route with no row reads as it did without the file,
and a record without the file is asked for nothing. Components, requirements and stories
have no manifest (creator decision 2026-09-14).

### design/feature-log.md (generated)

Frontmatter carries `generated: { by: forge-cli/<version>, at: <iso> }` and
`freeze: FREEZE-004` — the most recent freeze, since the file covers all of them. One
`## <tag> — <date>` section per freeze, newest first: a flat list of what closed since the
freeze before it, a `### Screens` list of which built routes changed, and a `### Decisions
accepted` list when any did. Tasks are not grouped by screen (creator decision 2026-07-24;
no `view:` field exists to group by). The `generated` key is the single marker of
derivation; the body opens with a one-line "generated by `forge freeze` — do not edit"
notice for humans reading it raw.

**Which screens changed is derived, not declared** (DDR-121). `forge freeze` records a
content hash of every built route's `index.html` on the freeze (`freezes.json#routes`),
which DDR-072's directory-per-route contract makes discoverable with no framework
knowledge. A route whose hash differs from the previous freeze's *changed*; one absent
before is *new*; one absent now was *removed*. Feedback carries the `route` it was left on,
so feedback `addressed_in` the tag is listed under its screen. A freeze cut before hashes
existed says so, and the one after it says the comparison is not available — neither
guesses.

**Declared intent sits beside the derived change** (DDR-130). When the record holds a
`pages.md` at the tag, each screen line carries the page's title and the IDs that touch
it — `` - `/register` changed — Sign up (STORY-003) — addresses FEEDBACK-002 `` — read
from the manifest as it stood at that freeze, so a page renamed later does not rewrite an
older section. A route with no row reads as it always did.

**"Closed since" is read from Git, not from a field.** A task carries `opened` and a
`status`, never a closed date; freezes are tags, so `forge freeze` compares the task ledger
at consecutive tags and lists the ids that reached Done between them. The whole file is
regenerated from the tags each freeze rather than appended to, so rebuilding it always
produces the same file — which is what makes checking it against a regeneration meaningful.

### design/checks/<tag>/<checker>.md (generated)

A check is a report the record keeps (DDR-127): what one checker found against one version,
at one commit. `forge check <tag>` writes one per checker under `checks/<tag>/` — `doctor`
always, and every command named in `forge.json#checks` — beside a verbatim `<checker>.json`.
Frontmatter carries `checker`, the checker's own `version`, `target` (the tag), `commit`,
`date`, `command`, an optional `score`, the counts `findings`, `errors` and `warnings`, and
`generated`, which is what makes the file derived. The body summarises in one line and lists
the findings in a fenced block, so an id a checker quotes stays a literal (§6). Screenshots
and other heavy artifacts stay out of the repository; a report may name them, the record does
not hold them.

**Forge specifies the report, never the checker.** A checker is any command that prints this
JSON to stdout:

```json
{
  "checker": "vizlint",
  "version": "0.3.1",
  "score": 87,
  "summary": "Two contrast failures on the sign-in screen.",
  "findings": [
    { "rule": "contrast-aa", "severity": "error", "message": "Body text is 3.2:1.",
      "route": "/", "selector": "main p", "fix": "Use the on-surface token." }
  ]
}
```

`checker`, `findings`, and each finding's `rule`, `severity` (`error | warning | info`) and
`message` are required; `version`, `score`, `summary`, and a finding's `route`, `selector`,
`file` and `fix` are optional. `forge.json#checks` lists checkers as `{ "name", "command",
"dir"? }`, and the name is the report file's. A checker that exits non-zero, or prints
anything but a report, has not produced a check, and `forge check` says which one. The
tree must be clean when it runs, because a report names the commit it checked.

**`forge freeze --require-check`** refuses to tag unless every expected checker has a
report under `checks/<tag>/` that describes the commit being tagged — naming it, or differing
from it only by the reports themselves, since the reports are committed after the check
runs. The `forge-review` skill's findings are not a report: they are `source: scan` feedback
(DDR-108), judgments a person dispositions, and the skill is an agent's to run.

## 6. Links

- Cross-references are bare IDs (`FEEDBACK-011`) or standard Markdown links. Tools must
  resolve both; humans may use either.
- Markdown links SHOULD use OKF's recommended **bundle-relative absolute** form —
  `[the template](/design/decisions/DDR-000-template.md)` — which survives a file
  moving within its directory.
- An ID mentioned anywhere must exist somewhere in the record. This is a Forge rule, not an
  OKF one: OKF requires consumers to tolerate broken links, so a generic consumer will not
  complain where `forge doctor` will.
- **Only a reserved prefix makes a reference** (DDR-071). §4's list is what defines an ID,
  so a same-shaped token with any other prefix — `UTF-8`, `ISO-8601`, `HTTP-2` — is prose,
  not a broken link.
- **An ID inside a code span or fenced block is a literal, not a reference** (DDR-069), and
  is not required to resolve. This is how a record documents the format's own ID shapes,
  names a fixture's concepts, or quotes an ID that deliberately does not exist. Backticks
  are the escape hatch: monospacing an ID you meant as a reference hides it from doctor.

## 7. Validation — `forge doctor`

Doctor is the format's contract enforcement. It checks, at minimum:

**OKF conformance (bundle-level)**
1. Every non-reserved `.md` file under `design/` has a parseable YAML frontmatter block.
2. Every frontmatter block has a non-empty `type`.
3. `index.md` and `log.md` follow OKF §8/§9 — no frontmatter, except a bundle-root
   `index.md` carrying only `okf_version`. A generated index (one carrying the body marker)
   still matches the concepts on disk; a hand-written one is not checked.

**Forge profile**
4. Every ID is unique across the record; numbering has no duplicates; `id` frontmatter
   matches the filename.
5. Every referenced ID resolves — IDs inside code spans and fenced blocks excepted, being
   literals rather than references (§6, DDR-069).
6. Enums are valid — `type` is in the §2 vocabulary, and the domain status fields, task
   statuses, feedback sources, a decision's `reach` and a concept's `audience` hold
   documented values.
7. `accepted` feedback links a TASK; `declined` feedback links a DDR.
8. Files carrying `generated` are unchanged since generation (hand-edits flagged) and name
   a generator the tooling knows.
9. Accepted decisions are unchanged since acceptance (amend via supersession).
10. `forge.json#formatVersion` is one the tooling understands; `forge upgrade` migrates.
11. No file name differs from an expected record file's only by case — on a
    case-insensitive filesystem the two are one path, so the record would otherwise read as
    valid and empty.
12. An amendment is recorded on both decisions: `amends` on the one that amends,
    `amended_by` on the one amended, once the amending decision is accepted (DDR-090).
13. A page manifest, when the record has one, has a readable row per page and declares no
    route twice after normalisation (DDR-130). A record without one is asked for nothing.

Skills end every session by running doctor and fixing what it reports. This is what lets
the model write content freely while the contract holds.

## 8. Versioning

This spec is versioned (`v0.2`); `forge.json#formatVersion` pins a record to a spec
version. Breaking changes to file names, entry shapes, ID rules, or enums bump the version
and ship with a `forge upgrade` migration. Additive changes (new optional fields, new
on-demand files) do not.

The bundle separately declares the OKF version it targets via `okf_version` in
`design/index.md` — currently `"0.2"`. When OKF revises, the profile re-conforms and this
spec bumps; the two version lines move independently.

**Earlier versions are migration sources, not supported formats** (DDR-095). The tooling
serves one format. A record declaring anything older gets a single message naming
`forge upgrade --to 0.2` from `forge doctor` and from every command that writes the
record; only `upgrade` itself still reads the old shapes. `forge upgrade` targets the
current format by default and runs both legs, so a record two versions behind reaches
current in one command — an intermediate stop would leave a record nothing will serve.

**Migrating from v0.1.** `forge upgrade` moves the record into `design/`, splits each
ledger file into concept files, writes frontmatter (deriving `type`, `id`, `date`, and the
domain status field from each row), rewrites the derived-file marker into `generated`, and
ends with an explicit report of superseded v1 sources — deleting them only with `--prune`
(creator decision 2026-07-24). Git remains the archive; no file disappears unasked.

**Migrating from v1.** The earlier leg renames every `T-###` to `TASK-###`. Because that
rename is the record's, not one file's, it follows the references: citations inside
`decisions/` are rewritten in place, so a decision does not end the migration pointing at
IDs that no longer exist. A `### ` heading a task sat under becomes its `phase:`
(DDR-068), and a ticked checkbox files the task as done wherever its section put it —
the box is what an author ticks when the work finishes, and a row whose checkbox and
`status:` disagree is not a record of anything.
