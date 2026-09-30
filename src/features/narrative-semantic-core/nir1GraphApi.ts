import { invoke } from "@/lib/tauri";

export interface Nir1GraphQuery {
  readonly expectedWorkspacePath: string;
  readonly projectId: string;
  readonly querySceneId: string;
  /** Explicit Codex Entity id. Names and body text are never resolved here. */
  readonly seedEntityId: string;
}

export interface Nir1GraphNode {
  readonly entityId: string;
  readonly entityType: string;
  readonly label: string;
  readonly hop: number;
  readonly evidenceIds: readonly string[];
}

export interface Nir1GraphEdge {
  readonly edgeId: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly relationType: string;
  readonly directionality: "directed" | "symmetric";
  readonly evidenceIds: readonly string[];
}

export interface Nir1GraphResult {
  readonly status: "available" | "unavailable";
  readonly projectId: string;
  readonly querySceneId: string;
  readonly scopeRevision: string | null;
  readonly graph: {
    readonly seedEntityId: string;
    readonly nodes: readonly Nir1GraphNode[];
    readonly edges: readonly Nir1GraphEdge[];
    readonly truncated: boolean;
  } | null;
  readonly reason: string | null;
}

/**
 * Fetches the Native bounded graph projection.  This is deliberately a
 * reader-only API: it does not persist Entity/Relation revisions or promote
 * the existing Codex catalog into NIR authority.
 */
export function queryNir1Graph(
  request: Nir1GraphQuery,
): Promise<Nir1GraphResult> {
  return invoke("nir1_graph_query", {
    expectedWorkspacePath: request.expectedWorkspacePath,
    projectId: request.projectId,
    querySceneId: request.querySceneId,
    seedEntityId: request.seedEntityId,
  });
}
