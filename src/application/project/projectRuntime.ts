export type ProjectPhaseResolutionMode = "reading" | "story" | "auto";

export interface ProjectMetadataProjection {
  language: string | null;
  phaseResolutionMode: ProjectPhaseResolutionMode | null;
}

export interface ProjectBackgroundActivation {
  projectId: string;
  canStart: () => boolean;
  isMutationCurrent: () => boolean;
}

export interface ProjectRuntimePort {
  applyMetadata: (metadata: ProjectMetadataProjection) => void;
  getFallbackLanguage: () => string | null;
  prepareExternalWriteFeedStop: () => Promise<() => void>;
  initializeTimelapse: (
    activation: ProjectBackgroundActivation,
  ) => Promise<void>;
  startExternalWriteFeed: (
    activation: ProjectBackgroundActivation,
  ) => Promise<void>;
}

let registeredProjectRuntime: ProjectRuntimePort | null = null;

/** Install concrete renderer integrations from the application composition root. */
export function registerProjectRuntime(port: ProjectRuntimePort): void {
  registeredProjectRuntime = port;
}

function projectRuntime(): ProjectRuntimePort {
  if (!registeredProjectRuntime) {
    throw new Error("Project runtime dependencies are not registered");
  }
  return registeredProjectRuntime;
}

export function applyProjectMetadata(
  metadata: ProjectMetadataProjection,
): void {
  projectRuntime().applyMetadata(metadata);
}

export function getFallbackProjectLanguage(): string | null {
  return registeredProjectRuntime?.getFallbackLanguage() ?? null;
}

export function prepareExternalWriteFeedStop(): Promise<() => void> {
  return projectRuntime().prepareExternalWriteFeedStop();
}

export function initializeProjectTimelapse(
  activation: ProjectBackgroundActivation,
): Promise<void> {
  return projectRuntime().initializeTimelapse(activation);
}

export function startProjectExternalWriteFeed(
  activation: ProjectBackgroundActivation,
): Promise<void> {
  return projectRuntime().startExternalWriteFeed(activation);
}
