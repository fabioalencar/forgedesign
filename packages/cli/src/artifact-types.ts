/**
 * The single structured-deliverable taxonomy from DDR-024. These are durable
 * project records (not composer output formats or singular project documents).
 */
export interface ArtifactType {
  id: string;
  label: string;
  description: string;
}

export const ARTIFACT_TYPES = [
  { id: "user-flows", label: "User flows", description: "Paths through a product experience." },
  { id: "journey-maps", label: "Journey maps", description: "End-to-end user journeys." },
  {
    id: "service-blueprints",
    label: "Service blueprints",
    description: "Frontstage and backstage service behavior.",
  },
  { id: "site-audits", label: "Site audits", description: "Observed product and experience gaps." },
  { id: "personas", label: "Personas", description: "Audience archetypes and needs." },
  {
    id: "competitive-analysis",
    label: "Competitive analysis",
    description: "Comparable products and market patterns.",
  },
  { id: "user-stories", label: "User stories", description: "Structured user needs and outcomes." },
  {
    id: "data-model",
    label: "Data model",
    description: "Product concepts and their relationships.",
  },
  { id: "process-flow", label: "Process flow", description: "Operational or system steps." },
] as const satisfies readonly ArtifactType[];

export type ArtifactTypeId = (typeof ARTIFACT_TYPES)[number]["id"];

export const ARTIFACT_STATUSES = ["none", "draft", "in-review", "done"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];
export const INITIAL_ARTIFACT_STATUS: ArtifactStatus = "none";

export function getArtifactType(id: string | undefined): ArtifactType | null {
  return ARTIFACT_TYPES.find((artifact) => artifact.id === id) ?? null;
}

export function isArtifactTypeId(id: string): id is ArtifactTypeId {
  return getArtifactType(id) !== null;
}

/** Initial manifest for a selected project deliverable. */
export function artifactIndexMarkdown(artifact: ArtifactType): string {
  return `---
type: artifact
artifact: ${artifact.id}
status: ${INITIAL_ARTIFACT_STATUS}
---
# ${artifact.label}

${artifact.description}

No deliverable has been drafted yet.
`;
}
