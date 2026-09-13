export type Constraint =
  | { kind: "any" }
  | { kind: "exact"; ref: string }
  | { kind: "unresolved"; reason: string };

export type Principal =
  | { kind: "reader" }
  | { kind: "character"; ref: string };

export type Registry = {
  registryVersion: string;
  timelineRefs: string[];
  worldlineRefs: string[];
  narrativeLayerRefs: string[];
};

export type Binding = {
  schemaVersion: 1;
  projectId: string;
  sceneId: string;
  sceneIncarnationId: string;
  compatibilityMarker: "legacy-absent" | "explicit" | "unknown";
  queryIdentity: {
    timeline: Constraint;
    worldline: Constraint;
    narrativeLayer: Constraint;
  };
  materialConstraint: {
    timeline: Constraint;
    worldline: Constraint;
    narrativeLayer: Constraint;
  };
  knowledgeHolder: Principal;
  audience: Principal;
  version: number;
  sourceToken: string;
  updatedAt: string;
};

export type RegistryUpdate = {
  registry: Registry;
  registryRevision: number;
  registrySourceToken: string;
  registryUpdatedAt: string;
};

export type ScopeRead = RegistryUpdate & { binding: Binding };
export type ScopeUpdate = { registry: Registry; binding: Binding };
