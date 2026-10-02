// Mermaid fences in a concept body (spec/format.md §5, DDR-056). Flows carry a
// `flowchart`, the data model an `erDiagram`; every reader that draws them —
// the dashboard, the release hub — splits the body the same way, so the split
// lives here rather than in whichever renderer wrote it first (TASK-460).

export interface SplitMermaid {
  /** every ```mermaid fence in the body, in order, trimmed */
  diagrams: string[];
  /** everything that is not a diagram — the prose around them */
  prose: string;
}

/**
 * The ```mermaid fences in a concept body, and the prose left over. A flow may
 * carry more than one diagram (a happy path and its failure branch), so this
 * returns every fence rather than the first.
 */
export function splitMermaid(body: string): SplitMermaid {
  const diagrams: string[] = [];
  const prose: string[] = [];
  let fence: string[] | null = null;

  for (const line of body.split("\n")) {
    if (fence === null && /^\s*```\s*mermaid\s*$/.test(line)) {
      fence = [];
      continue;
    }
    if (fence !== null) {
      if (/^\s*```\s*$/.test(line)) {
        diagrams.push(fence.join("\n").trim());
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    prose.push(line);
  }
  // An unterminated fence is still a diagram someone wrote; dropping it would
  // hide the content over a missing three characters.
  if (fence !== null && fence.length > 0) diagrams.push(fence.join("\n").trim());

  return { diagrams, prose: prose.join("\n").trim() };
}
