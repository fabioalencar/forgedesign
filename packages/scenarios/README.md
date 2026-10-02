# @forgedesign/scenarios

The browser runtime a prototype imports so a reviewer can be shown the app as a particular
role, with particular data, from a URL. It reads `?scenario=` and answers `can()`, `flag()`,
the scenario's data and its route rules. Zero dependencies.

```sh
npm install @forgedesign/scenarios
```

Scenarios are declared in the record (`design/scenarios/SCENARIO-###.md`), and
`forge freeze` emits them into the build. See
[`spec/format.md`](https://github.com/fabioalencar/forgedesign/blob/main/spec/format.md).

Apache-2.0.
