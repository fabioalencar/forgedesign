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

Everything here runs in your repository, with no account:

```sh
forge init                  # a design/ record in this repo, including one that already has code
forge skills install --home # the agent skills, for Claude Code and Codex
forge doctor                # check the record against the format's rules
forge freeze v1             # tag an immutable version and build it: static files, any host serves them
forge comments import figma <file>    # or: forge comments import issues <owner/repo>
forge comments triage apply <batch>   # after your agent dispositions the feedback
```

Skills talk, the CLI writes: judgment happens in your agent session (the `forge-*` skills),
and a `forge` command is what actually touches the record, so ids and statuses stay
consistent.

## Forge Cloud (closed beta)

[Forge Cloud](https://useforge.design) hosts a freeze behind a PIN-gated review link and
brings the stakeholder's comments back to your repository. It is a closed beta for now,
with invited accounts only and no open sign-up. Its commands are listed apart in
`forge --help`:

```sh
forge login                 # invited accounts
forge publish v1            # a review link and PIN for a stakeholder
forge comments triage v1    # stage their comments for your agent to disposition
```

Invited creators sign in at [app.useforge.design](https://app.useforge.design) and find or
change review PINs on its [Prototypes page](https://app.useforge.design/prototypes).

This branch targets **0.1.1; npm publication is pending**. The published `0.1.0` still
calls the retired website API. In the new CLI, an unset Cloud address or the old default
`https://useforge.design` (with or without a trailing slash) uses the app host. Custom
addresses stay as configured. The move does not rewrite your config or require a new
login; existing valid tokens continue to work.

Publishing to Cloud uses staged uploads: the CLI declares the build, uploads its files
directly to storage, and asks Cloud to validate and commit the version. A review becomes
available after that commit succeeds. Servers that do not advertise staged uploads retain
the earlier single-request publishing path, with a size check before anything is sent.

`forge --help` lists every command. The format is specified in
[`spec/format.md`](https://github.com/fabioalencar/forgedesign/blob/main/spec/format.md).

Apache-2.0.
