---
type: Task Ledger
title: Todos
---
This record starts at the extraction (`DDR-001`). Work that predates it lives in the
private repository it came from and is deliberately not copied — that decision explains
why a record cannot be divided.

## Todo
- [ ] TASK-002 Move the review overlay in as its own package
  status: todo · opened: 2026-08-03
  genesis: DDR-001
  notes: The comment overlay a stakeholder sees on a frozen review is authored source and belongs in the open half, but it did not come across in the extraction. `DDR-001` records why: until the packages publish, the private service would still build its own copy, so moving it now would mean two copies of one source with no consumer for the second — which is how sources silently diverge. Sequence it with TASK-001. When it lands the private service consumes the published artifact instead of compiling the source itself, which also retires a build step there that reaches outside its own directory.
- [ ] TASK-003 A README that shows the loop rather than describing it
  status: todo · opened: 2026-08-03
  genesis: DDR-001
  notes: The README states what the packages are. What a first-time reader needs is the loop end to end — `forge init` on a repository that already has code, a decision written while building, `forge freeze` producing a portable static build, and a stakeholder's comment landing back in the record as a task with a `genesis`. That is a walkthrough against a real project rather than prose, and it is the difference between a spec someone skims and a tool someone tries.

## Doing
- [ ] TASK-001 Publish the packages to npm under the @forgedesign scope
  status: doing · opened: 2026-08-03
  genesis: DDR-001
  notes: All three manifests declare `private: true`, which is what stops an accidental publish; the scope itself is already held. What has to be decided first is the version story — these are `0.1.0` and have never been released, so the first tag is a promise about what breaks and when. Specifically: whether the three packages version together or independently. `format` is what every consumer parses through, so a breaking change there is a breaking change everywhere, while independent versions would let the CLI move quickly with the grammar standing still. Blocked on nothing technical; the gates pass in this repository alone.
  progress: 2026-10-02 · Ready to publish except for the version decision above. The packages are in step with source (the skills renamed `forge-*`, the record snapshot at publish, page manifests), `private` is gone and `publishConfig.access` is `public` in all three, each has a README for its npm page, and the stale `artifact-types` export is removed. Packed with `pnpm pack` (which rewrites `workspace:*` to the exact version, so publish with `pnpm publish -r`, never `npm publish`) and installed into an empty directory: `init`, `skills install` (project and `--home`), `doctor` and `status` work, and `dash` is hidden because there is no dashboard to start. The repository must be public at the same moment, or every `repository` link on npm answers 404.

## Done

## Deferred
