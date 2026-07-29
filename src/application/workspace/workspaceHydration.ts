import type { GlobalSettings } from "@/lib/globalSettings/GlobalSettings";

export interface WorkspaceHydrationInput {
  projectId: string;
  settings: GlobalSettings;
  /** New workspaces need their project defaults seeded once. */
  isExisting: boolean;
}

export interface WorkspaceHydrationDependencies {
  migrateAppSettingsToScopedStores: () => Promise<void>;
  migrateModelRoleKeys: () => Promise<void>;
  removeRetiredDisplaySettings: () => Promise<void>;
  seedProjectSettingsFromDefaults: () => Promise<void>;
  loadSettings: (projectId: string) => Promise<void>;
  initCursorSettings: () => void;
  initCodexHighlight: () => void;
  initAttribution: () => void;
  initAnnotation: () => void;
  loadLintConfig: () => void;
  loadTimelineSettings: (
    settings: NonNullable<GlobalSettings["timeline"]>,
  ) => void;
  loadChronicleSettings: (
    settings: NonNullable<GlobalSettings["chronicle"]>,
  ) => void;
  loadMapSettings: (settings: GlobalSettings) => void;
  loadGridSettings: (settings: GlobalSettings) => void;
  loadMatrixSettings: (settings: GlobalSettings) => void;
}

let registeredHydrator:
  | ((input: WorkspaceHydrationInput) => Promise<void>)
  | null = null;

/**
 * Compose the mandatory post-swap Workspace hydration sequence.
 *
 * The Workspace feature owns the lifecycle boundary, while this application
 * service owns the cross-feature ordering. Keeping the dependencies typed also
 * makes the order testable without importing the concrete stores in lifecycle
 * tests.
 */
export function createWorkspaceHydrator(
  dependencies: WorkspaceHydrationDependencies,
): (input: WorkspaceHydrationInput) => Promise<void> {
  return async ({ projectId, settings, isExisting }) => {
    await dependencies.migrateAppSettingsToScopedStores();
    await dependencies.removeRetiredDisplaySettings();
    await dependencies.migrateModelRoleKeys();

    if (!isExisting) {
      await dependencies.seedProjectSettingsFromDefaults();
    }

    await dependencies.loadSettings(projectId);
    dependencies.initCursorSettings();
    dependencies.initCodexHighlight();
    dependencies.initAttribution();
    dependencies.initAnnotation();
    dependencies.loadLintConfig();

    if (settings.timeline) {
      dependencies.loadTimelineSettings(settings.timeline);
    }
    if (settings.chronicle) {
      dependencies.loadChronicleSettings(settings.chronicle);
    }
    dependencies.loadMapSettings(settings);
    dependencies.loadGridSettings(settings);
    dependencies.loadMatrixSettings(settings);
  };
}

/** Install concrete store adapters from the renderer composition root. */
export function registerWorkspaceHydrationDependencies(
  dependencies: WorkspaceHydrationDependencies,
): void {
  registeredHydrator = createWorkspaceHydrator(dependencies);
}

/** Run the registered Workspace hydrate sequence at the lifecycle boundary. */
export async function hydrateWorkspaceStores(
  input: WorkspaceHydrationInput,
): Promise<void> {
  if (!registeredHydrator) {
    throw new Error("Workspace hydration dependencies are not registered");
  }
  await registeredHydrator(input);
}
