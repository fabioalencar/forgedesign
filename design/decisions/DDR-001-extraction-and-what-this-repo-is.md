---
type: Decision
id: DDR-001
title: "This repository is the open half, extracted as a fresh history with a record of its own"
date: 2026-08-03
decision_status: accepted
context_source: the extraction itself — the first commit of this repository
---
## Decision

Forge's open half — the record format, the CLI, the scenario runtime and the agent skills —
lives here, under **Apache-2.0**, as a **fresh repository with a single initial commit**
rather than a history split from the private repository it came from.

The commercial half stays private: hosting a frozen version at a URL, the gate in front of
it, the comment service behind it, the dashboard, and the account system.

**This repository keeps a Design Record of its own**, starting at this decision. It is not
a copy or a slice of the private one. Decisions made there stay there; decisions made here
from this commit forward live here. Two products, two records, no shared ids — and no
decision in this repository will ever cite an id that a reader outside cannot resolve.

## Why

**A record cannot be divided.** The private repository's record carries thousands of
cross-references, and its own validator requires every referenced id to resolve inside the
bundle. Copying a subset here would produce a record that fails the contract this project
exists to demonstrate — in the repository whose job is to demonstrate it. Starting a new
record is the only option that leaves both valid.

**A fresh history rather than a subtree split.** The original history is almost entirely
about a product this one no longer is: an earlier version of Forge orchestrated the build
itself, and that was abandoned in favour of the record. Carrying several hundred commits
about deleted architecture would give a newcomer a history that mostly misleads. Git in the
private repository keeps the real lineage; what this repository needs is a legible present.

**Apache-2.0 rather than MIT, for the patent grant.** MIT is shorter and would cost nothing
today. What it lacks is an express patent licence from contributors and the retaliation
clause that comes with it, so a contributor could accept a merge and later assert a patent
over what they contributed. Low probability, unbounded cost, and worth insuring against
precisely when there is a business attached.

**The split is drawn at serving, not at capability.** Everything that produces a record is
here. What is withheld is the service that shows a frozen version to someone else. That line
is defensible because a freeze is a portable directory of static files: you can host one
yourself, and what you would be reimplementing is a server, not a format. A split that held
back part of the *format* would make the open half a demo, which is the failure mode of
open-core projects and is not what this is.

## Alternatives rejected

**Extract the commercial half instead and keep this repository private.** Rejected because
the record contains pricing, plan limits and hosting decisions, and it is the record that
cannot be divided — so whichever repository keeps it keeps that material. Moving the
commercial half out would have left commercial decisions in the repository that goes public.

**`git subtree split` to preserve history.** The conventional choice, and wrong here for the
reason above: the preserved history would be mostly about an abandoned architecture.

**One repository with the commercial half behind a licence header.** Simpler to maintain and
worse for everyone: a reader cannot tell what they may use, and a single accidental root
licence file would be an unintended grant over the commercial half.

**Publish immediately to npm at extraction.** Deliberately not done in this commit. The
packages still declare `private: true`, which is what stops an accidental publish; taking
that off is a separate, harder-to-reverse step than creating a repository.

## Consequences

**This repository is its own first user.** It carries a `forge.json` and a `design/` bundle,
and its CI runs `forge doctor` against itself. If the format is awkward to work in, that
will show up here first — which is the point.

**Contributions follow the record's rules**, and CI enforces them rather than a reviewer
remembering: one commit per task, accepted decisions immutable, non-obvious choices written
down before the code that implements them. `CONTRIBUTING.md` states the whole of it.

**The review overlay is not here yet.** Its source belongs in the open half and will move
when the packages publish — the private service will then consume the published artifact
rather than building its own copy. Until that happens, moving it would mean two copies of
the same source in two repositories with no consumer for the second, which is how sources
silently diverge.

**Nothing here depends on the private repository.** That is checked rather than assumed: the
packages build, typecheck, test, lint and pass their unused-code gate in this repository
alone, and the CLI's build no longer reaches for a sibling package that did not come with
it.
