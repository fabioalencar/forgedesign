# Skills

Agent Skills (SKILL.md folder format) for working a Forge Design Record. Each one is
conversation and judgment only — the `forge` CLI does every write into the record, so the
file shapes and ids stay deterministic no matter which agent runs the skill. Every skill
ends by running `forge doctor`.

| Skill | Use it when |
|---|---|
| [`forge-init`](forge-init/SKILL.md) | Setting up the record in a repo — usually adopting an existing one |
| [`ddr`](ddr/SKILL.md) | A non-obvious choice was made and needs recording |
| [`intake`](intake/SKILL.md) | Raw context (transcript, meeting note) needs classifying into proposals |
| [`triage`](triage/SKILL.md) | Stakeholder comments on a freeze need dispositioning |
| [`freeze`](freeze/SKILL.md) | Cutting a version for review |

[`AGENTS.md`](AGENTS.md) is the same process restated as plain project context for Codex,
which has no skill-invocation mechanism. **A change to any SKILL.md here needs mirroring
there** — the two are derived from one list of process steps and are only useful while they
agree.

## How these reach a user

They ship *inside* the published CLI rather than through a separate marketplace,
so a skill and the `forge` commands it calls can never be different versions. A user runs:

```sh
forge skills install          # → .claude/skills/
forge skills install --agents # → also a root AGENTS.md, for Codex
```

Installed files carry a marker, which is what makes a rerun safe: the command replaces its
own earlier output and never touches a skill you wrote yourself. `AGENTS.md` is more
cautious still — a repo's root agent instructions are the project's, so it is only written
when absent.
