# @forgedesign/format

The parser and serialiser for the Forge Design Record: schemas, frontmatter, id allocation
and link-graph resolution. Every Forge tool reads a record through this package, so there is
one grammar rather than one per tool.

```sh
npm install @forgedesign/format
```

The format it implements is specified in
[`spec/format.md`](https://github.com/fabioalencar/forgedesign/blob/main/spec/format.md). Most
people want the CLI, [`@forgedesign/cli`](https://www.npmjs.com/package/@forgedesign/cli), not
this package directly.

Apache-2.0.
