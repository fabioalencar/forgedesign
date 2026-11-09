# Changelog

## 0.2.0 — 2026-11-08

The first full sync of the packages with their source since 0.1.0; 0.1.1 and 0.1.2 carried only focused fixes.

New:

- `forge changelog draft` and `forge changelog apply`, and a new record type, `Change` (`design/changes/CHANGE-###.md`, `change_status: coming | exploring | done`). The draft stages what closed since the last freeze, with pages, the person who asked and ticket links filled in; you keep and reword what stakeholders should read, before freezing. `forge doctor` checks the entries' routes, links and ids.
- `forge publish` takes a screenshot of every route of the build it sends (at most 100) in a local headless Chromium, so Forge Cloud can show each changed screen before and after. Playwright is optional: install it beside your project (`npm install -D playwright && npx playwright install chromium`), or pass `--no-captures`. A screenshot that fails never fails a publish.
- `forge publish` sends a generated `changelog.json` with the record: each entry as read, the version each done entry shipped in, and the page titles from `pages.md`.
- `forge intake` stages decisions for `forge ddr apply` and no longer files artifact requests.
- Triage: a comment its author withdrew reaches triage without editing the record, and `apply` refuses a batch that changed since it was staged.

Safer:

- The release hub links only to http, https, mailto and relative targets, and refuses a target wrapped in whitespace, which a browser would trim into a `javascript:` link.
- The task ledger and `freezes.json` are changed under a lock in `.forge/locks`, so two writers no longer lose each other's changes. State files are written to a temp file and renamed into place, `config.json` is always 0600, and a new concept is created exclusively, so a writer that picked a taken id is refused.
- A freeze that fails after tagging puts back every file it wrote, and tells Cloud what it addressed only after its commit exists.
- `recordRoot` cannot point outside the repository, a dataset name cannot point outside its dataset, and a revision read from `freezes.json` can no longer make git write a file.

Faster and clearer:

- `forge doctor` reads accepted decisions in one batch (1.27 s to 0.27 s on Forge's own record), and commands start about twice as fast because the handoff pack loads its PDF and Word libraries only when it renders.
- Every refusal prints one message and a stable exit code.
- Record dates are your local calendar day, so an evening freeze is no longer dated tomorrow.
- `forge status` gives Forge Cloud 10 s to count comments and says "timed out" when it runs out.

Breaking, for code that imports the CLI as a library: the subpaths `@forgedesign/cli/commands/comments`, `/commands/init`, `/commands/explore` and `/commands/freeze` are now `@forgedesign/cli/comments`, `/init`, `/explore` and `/freeze-ceremony`, and `/file-lock` and `/atomic-write` are new. The `forge` command itself is unchanged.

Known issue: two `forge` processes recovering the same stale lock at the same moment can both proceed, so one write may be lost. It needs two runs on one repository at the same instant; a fix is tracked.

All three packages (`cli`, `format`, and `scenarios`) use 0.2.0. The Design Record format version remains 0.2: the `Change` type and the `CHANGE` id prefix are additions.

## 0.1.2 — 2026-10-29

- `forge skills install` writes its marker below each skill's frontmatter instead of above it. With the marker first, Claude Code read the marker line as the skill's description and never picked a `forge-*` skill up on its own; the skills only ran when called by name. Run `forge skills install` again (with `--home` if you installed that way) to repair skills installed by 0.1.0 or 0.1.1.

All three packages (`cli`, `format`, and `scenarios`) use 0.1.2. Only the CLI changed. The Design Record format version remains 0.2.

## 0.1.1 — 2026-10-16

- Restore Forge Cloud connectivity after its move to `app.useforge.design`. The CLI also reads a saved `https://useforge.design` as the app host, keeps the existing token, and preserves custom Cloud addresses.
- Publish through Cloud's staged-upload protocol: declare file sizes and hashes, upload bytes directly, then commit after every upload succeeds. Retry temporary upload failures; retain single-request publishing for servers that do not advertise staged uploads.
- Include the frozen tag's message when publishing and point PIN guidance to the Cloud app's Prototypes page.
- Keep reported CLI and generated-report versions aligned with the package version.

All three packages (`cli`, `format`, and `scenarios`) use 0.1.1. Existing library import paths and intake behavior remain compatible with 0.1.0. The Design Record format version remains 0.2.

## 0.1.0 — 2026-10-02

First npm release of the CLI, Design Record format, scenario runtime, and bundled agent skills.
