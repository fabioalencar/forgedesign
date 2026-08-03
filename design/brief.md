---
type: Brief
title: Brief
---
# Brief

## What it is

Forge is **the design record for AI-built prototypes**. It is not the build tool. The
building happens in your own coding agent — Claude Code, Codex, whatever you route to —
and Forge owns what that work leaves behind: the decisions, the tasks, the stakeholder
feedback, and the frozen versions people were actually shown.

This repository is the **open half**: the file format, the CLI that reads and writes it,
the scenario runtime a prototype links against, and the agent skills that drive the
workflow. All Apache-2.0.

- **`@forgedesign/format`** — the parser and serialiser for the Design Record. Every other
  consumer reads a record through this package, so a record has one grammar rather than one
  per tool.
- **`@forgedesign/cli`** — `forge`. `init` a record, `doctor` it, `freeze` a version,
  `ddr apply` a decision, `triage` stakeholder comments back into it.
- **`@forgedesign/scenarios`** — the browser runtime a prototype imports so a reviewer can
  be shown the app as a particular role, with particular data, from a URL.
- **`skills/`** — the agent skills. The pattern throughout is *skills talk, the CLI writes*:
  judgment happens in your agent session, and a `forge` command is what actually touches the
  record, so ids and enums stay deterministic.

The format itself is specified in [`spec/format.md`](../spec/format.md). It is an
OKF-conformant profile: a bundle of markdown concept files with frontmatter, which means a
record is readable by a human, by an agent, and by `git diff`.

## Who it's for

A designer or a small product team building prototypes with an AI agent, who have
discovered that the prototype is the easy part and everything around it is not —
remembering why a choice was made, showing a stakeholder a specific version, and getting
their reaction back somewhere it will not be lost.

The immediate reader is a **designer who works in a coding agent**, not a backend engineer
adopting a spec. Commands should be runnable without reading the spec first, and the spec
should be there when the answer matters.

## What it is not

- **Not a design tool.** Nothing here draws anything. The prototype is code your agent
  writes.
- **Not a project manager.** The task ledger exists because decisions and feedback need
  somewhere to land, not to replace whatever tracker you already have.
- **Not a runtime.** A Forge prototype is a static build: HTML, CSS and JS a dumb host can
  serve. No server rendering, no database, no secrets.
- **Not the hosted product.** Publishing a frozen version to a URL a stakeholder can open,
  the PIN gate in front of it, and the comment service behind it are a separate commercial
  service. This repository is what you can run yourself, forever, without an account.

## The line between this and the paid service

Worth stating plainly, because open-core projects usually leave it vague. **Everything that
produces a record is here and is Apache-2.0**: the format, the CLI, the runtime, the
skills. What the paid service sells is *serving* a frozen version to someone else — hosting,
the gate, the comment API, the account. A freeze is a portable directory of static files, so
you can host one yourself and never involve the service at all. What you would be
reimplementing is a server, not a format.
