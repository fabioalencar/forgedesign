# @forgedesign/cli

The `forge` command: the design record for AI-built prototypes. Your coding agent builds the
prototype; Forge keeps what that work leaves behind (decisions, tasks, stakeholder feedback
and the frozen versions people were actually shown) as Markdown in your repository.

```sh
npm install -g @forgedesign/cli
```

Node 20 or later. Atlassian's `@forge/cli` also installs a `forge` binary; with both
installed, whichever came last answers.

## The loop

```sh
forge init                  # a design/ record in this repo, including one that already has code
forge skills install --home # the agent skills, for Claude Code and Codex
forge doctor                # check the record against the format's rules
forge freeze v1             # tag an immutable version and build it
forge login                 # Forge Cloud, to send it for review
forge publish v1            # a review link and PIN for a stakeholder
forge comments triage v1    # stage their comments for your agent to disposition
```

Skills talk, the CLI writes: judgment happens in your agent session (the `forge-*` skills),
and a `forge` command is what actually touches the record, so ids and statuses stay
consistent.

`forge --help` lists every command. The format is specified in
[`spec/format.md`](https://github.com/fabioalencar/forgedesign/blob/main/spec/format.md).

Apache-2.0. Hosting a review (`login`, `publish`, `comments`) uses
[Forge Cloud](https://useforge.design); everything else works offline in your repo.
