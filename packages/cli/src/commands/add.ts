import type { ConceptType } from "@forgedesign/format";
import type { Command } from "commander";
import {
  addConcept,
  CONCEPT_CATALOGUE,
  type ConceptEntry,
  resolveConcept,
} from "../add-concept.js";

/**
 * Bare `forge add` prints the whole set rather than an error.
 *
 * This listing *is* the feature (TASK-391): the concepts are all optional, so
 * nothing else in the product ever mentions that a glossary, a data model or a
 * component inventory can exist. The ones another command owns are listed too —
 * omitting them would answer "what can a record hold" wrongly, and the point is
 * to answer that question in one place.
 */
function listConcepts(): void {
  const entries = Object.entries(CONCEPT_CATALOGUE) as Array<[ConceptType, ConceptEntry]>;
  const addable = entries.filter(([, entry]) => entry.writtenBy === undefined);
  const owned = entries.filter(([, entry]) => entry.writtenBy !== undefined);

  const width = Math.max(...addable.map(([, entry]) => command(entry).length));

  console.log("What a record can hold. Add one when you have something true to put in it:\n");
  for (const [, entry] of addable) {
    console.log(`  ${command(entry).padEnd(width)}  ${entry.purpose}`);
  }
  console.log("\nWritten by another command, so `forge add` will not:\n");
  for (const [type, entry] of owned) {
    console.log(`  ${type.padEnd(width)}  ${entry.writtenBy}`);
  }
}

function command(entry: ConceptEntry): string {
  return entry.names ? `add ${entry.keys[0]} <name>` : `add ${entry.keys[0]}`;
}

export function registerAddCommand(program: Command): void {
  program
    .command("add")
    .argument("[concept]", "which concept to add — run bare to see the whole set")
    .argument("[name]", "what it is called, for the concepts that hold more than one")
    .description("create one of the record's on-demand concepts (spec/format.md §2)")
    .action(async (concept: string | undefined, name: string | undefined) => {
      if (!concept) {
        listConcepts();
        return;
      }
      try {
        const result = await addConcept(process.cwd(), concept, name);
        console.log(`forge add: wrote ${result.path}`);
        const entry = CONCEPT_CATALOGUE[result.type];
        if (entry.guidance) console.log(`  ${entry.guidance}`);
      } catch (error) {
        console.error(`forge add: ${error instanceof Error ? error.message : String(error)}`);
        // A near miss is the common case — `forge add flow` for `flows`,
        // `forge add ddr` for a decision — so name the neighbour rather than
        // making the user run a second command to find it.
        if (resolveConcept(concept) === null) {
          console.error(
            `  the set is: ${Object.values(CONCEPT_CATALOGUE)
              .map((entry) => entry.keys[0])
              .join(", ")}`,
          );
        }
        process.exitCode = 1;
      }
    });
}
