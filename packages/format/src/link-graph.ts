// Pure link-graph primitives (spec/format.md §5, §6 rules 1–2): duplicate-id
// and unresolved-reference detection over already-extracted id lists. Callers
// (record.ts / the CLI's doctor command) assemble those lists per file type.

export interface DuplicateId {
  id: string;
  count: number;
}

export function findDuplicateIds(ids: Iterable<string>): DuplicateId[] {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ id, count }));
}

/** Referenced ids (deduplicated) that don't appear in `knownIds`. */
export function findUnresolvedRefs(
  refs: Iterable<string>,
  knownIds: ReadonlySet<string>,
): string[] {
  const unresolved = new Set<string>();
  for (const ref of refs) if (!knownIds.has(ref)) unresolved.add(ref);
  return [...unresolved];
}
