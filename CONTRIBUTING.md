# Contributing

## Open an issue before writing code

Forge is pre-1.0 and most changes touch a decision rather than just an implementation. Open
an issue first and we will tell you quickly whether the change is one we want and what it
would need — that costs you five minutes, where a pull request we decline on design grounds
costs you a weekend.

Issues are welcome with no preamble: bugs, confusing behaviour, a command that did
something you did not expect, a part of the format that does not fit your project.

## How this repository works

It is a Design Record for itself. That is not decoration — the rules below are enforced by
CI, and a change that ignores them will fail before a human reads it.

**Every change belongs to a task.** Tasks live in [`design/todos.md`](design/todos.md) with
ids like `TASK-123`. Commits are `[TASK-###] short description`, one commit per completed
task. Move the task between `## Todo`, `## Doing` and `## Done` as you work, and keep the
checkbox and `status:` in agreement.

**Non-obvious choices get a decision record.** A library, a pattern, a tradeoff — write
`design/decisions/DDR-###-slug.md` from
[the template](design/decisions/DDR-000-template.md) and reference it in the commit.
Accepted decisions are **immutable**: to change one, write a new decision that supersedes
it. CI enforces this against the merge target, so amending an accepted DDR inside a pull
request fails the build.

**If the answer is not in the spec or a decision, stop and ask.** Write the question into
the task's `notes:` and say so in the pull request. Guessing at a product decision is the
one thing we would rather you did not do.

## Before you push

```bash
pnpm install && pnpm -r build
```

Then the whole gate, which is exactly what CI runs:

```bash
pnpm -r typecheck && pnpm lint && pnpm -r test && pnpm knip && node packages/cli/dist/index.js doctor .
```

`forge doctor` validates this repository against the format it enforces on users:
unresolvable ids, duplicate ids, invalid enum values, a stale bundle index, a hand-edited
derived file. It must print `doctor: clean`.

Two things that trip people up: an id in a code span is treated as a literal and is not
asked to resolve, so backtick the ids that belong to another record; and `pnpm lint` is one
biome invocation from the root covering the whole workspace, not per-package.

## What to read first

- [`spec/format.md`](spec/format.md) — the Design Record format. Read the relevant section
  before changing anything the CLI, the skills, or the renderer touch.
- [`design/brief.md`](design/brief.md) — what this is, who it is for, and where the line
  between this and the paid service falls.
- [`design/decisions/`](design/decisions/) — every decision made in this repository. There is
  one so far: the extraction that created it.

## Licensing

Everything in this repository is Apache-2.0. Contributions are accepted under that licence —
its §5 already grants what a contributor licence agreement would, so there is no CLA to
sign.

The hosted service is a separate, private codebase and takes no outside contributions. If a
change you want touches the boundary between them, open an issue and say so; that is a
design conversation, not a patch.
