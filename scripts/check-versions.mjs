// The three packages publish under one version (DDR-002). A CLI at 0.3.0 always
// carries the format at 0.3.0, so "which format does this CLI write" never has
// an answer other than its own number. This fails CI the moment one moves alone.
import { readFileSync } from "node:fs";

const packages = ["cli", "format", "scenarios"];
const versions = packages.map((name) => {
  const manifest = JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8"));
  return { name: manifest.name, version: manifest.version };
});

const distinct = new Set(versions.map((entry) => entry.version));
if (distinct.size !== 1) {
  console.error("check-versions: the packages publish under one version (DDR-002), but:");
  for (const entry of versions) console.error(`  ${entry.name} ${entry.version}`);
  process.exit(1);
}
console.log(`check-versions: all ${versions.length} packages at ${[...distinct][0]}`);
