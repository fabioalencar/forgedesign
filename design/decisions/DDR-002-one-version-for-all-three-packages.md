---
type: Decision
id: DDR-002
title: The three packages publish under one version number
date: 2026-10-02
decision_status: accepted
context_source: TASK-001's open question, answered by the creator 2026-10-02 before the first publish
---
## Decision

`@forgedesign/cli`, `@forgedesign/format` and `@forgedesign/scenarios` always carry the same
version and are published together. The first release is `0.1.0`. A change to any one of them
moves all three. CI fails when the three manifests disagree (`pnpm check:versions`), and
publishing with `pnpm publish -r` pins the CLI's dependencies to that exact version.

## Why

The three move together in practice. `format` is the grammar the CLI writes, so a change there
is a change to what the CLI produces, and the scenario runtime is emitted into builds the CLI
makes. One number answers "which format does this CLI write" without a compatibility table:
its own. Most people install only the CLI, and the other two arrive as its dependencies, so
nobody gains from tracking three numbers.

## Alternatives rejected

**Independent versions.** They would let the CLI move quickly while the grammar stands still.
That only pays off once something other than the CLI consumes `format`, and nothing does yet.
If that changes, splitting later is easy; merging three histories back into one is not.

## Consequences

A fix to the CLI alone republishes `format` and `scenarios` unchanged under the new number.
That is accepted as cheap. Breaking-change policy is one decision rather than three: under 0.x,
a minor bump may break, and the release notes say what.
