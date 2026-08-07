# Security policy

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. That opens a private advisory only the maintainers can see.

Please do not open a public issue for a security problem, and please do not disclose it
publicly until a fix is available.

**What to expect:** an acknowledgement within 3 working days, and an assessment within 10.
If a report is valid, you will be credited in the advisory unless you ask not to be. This
is a small project — there is no bounty, and the response is a person, not a team.

**Useful things to include:** what an attacker gains, the smallest sequence of steps that
demonstrates it, and which host it applies to (see below — they have very different threat
models).

## What is in scope

| Surface | Notes |
| --- | --- |
| `frozen.design` — the review runtime | Serves published prototypes and the comment API. **The highest-value target**, because it serves user-authored JavaScript to stakeholders who are not the author. |
| `useforge.design` — the control plane | Accounts, plans, invites, device authorization, publishing. |
| `@forgedesign/cli` and the local dashboard | Anything that lets a repository, a record file, or a downloaded artifact execute code or read outside the project directory. |

Out of scope: findings against a prototype somebody built with Forge (that is their code),
missing hardening headers with no demonstrated impact, and reports from automated scanners
with no working proof.

## Known gaps

These are already filed, so a report about them tells us nothing new — but a way to make
them *worse* than described is very much worth reporting.

- **A published freeze is unlisted, not private.** `GET /p/<slug>/<tag>/…` authenticates
  nothing: the PIN currently gates commenting, not viewing. Artifact keys are also
  guessable, so knowing a prototype id is enough to read it. Treat a published prototype as
  world-readable to anyone with the URL until this changes.
- **No rate limiting** on the Cloud endpoints.

## Design notes that are deliberate

- **The two hosts are separate origins on purpose.** The review runtime serves
  user-authored JavaScript and must never share an origin with a logged-in session. A
  finding that lets content on `frozen.design` reach a `useforge.design` session is a
  serious one.
- **The CLI never asks you to paste a token.** `forge login` uses a device authorization
  flow; anything that prompts for a secret in a terminal is not us.
- **`~/.forge/config.json` holds credentials** and is written `0600`. Each machine's token
  is revocable on its own, so losing a laptop revokes that laptop.
- **The Cloud API address is read from your own config, never from a repository.** A
  `forge.json` cannot point the CLI at a different host, so cloning a hostile repo does not
  redirect your token somewhere else.
- **`forge.json` is committed, and three of its fields are commands.**
  `preview.command`, `preview.install` and `build.command` are read from the repository and
  executed — by `forge preview` and by `forge freeze` respectively. Running them is what
  those two commands *mean*, and it is the same trust you extend by running `npm install`
  on a repo you cloned: **treat `forge preview` and `forge freeze` as "run this project's
  code", and read a `forge.json` you did not write before you do.** Commands are split
  without a shell and run as an argv array, so there is no injection surface beyond the
  command itself. The read-only commands — `doctor`, `status`, `index`, `upgrade` — never
  execute any of it.
- **Content staged for an agent is data, not instruction.** `forge intake` and
  `forge comments triage` stage third-party text — transcripts, and comments from invited
  stakeholders — for an agent to classify or disposition, and the skills say in as many
  words that it must not be followed as direction. Two things bound the damage if an agent
  is steered anyway: the CLI writes the record, not the agent, and `triage apply` validates
  every task and DDR id before touching anything. A way past either is worth reporting.
