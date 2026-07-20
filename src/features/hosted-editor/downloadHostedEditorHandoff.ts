import {
  buildWebEditorHandoffFilename,
  buildWebEditorWorkspaceHandoff,
  type WebEditorUiLanguage,
} from "@grimodex/scan-contract";
import {
  registeredSaveHandlerIds,
  saveScene,
} from "@/features/editor/editorSaveRegistry";
import { getProject } from "@/features/project/api";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { awaitAllPendingSceneWrites } from "@/features/tree/pendingSceneWrites";
import { useWorkspaceStore } from "@/features/workspace/store";
import { flushAllAutoSaves } from "@/hooks/useAutoSave";
import { saveTextFile } from "@/lib/exportFile";
import i18next from "@/lib/i18n";
import { getHostedEditorRuntime } from "./hostedEditorRuntime";

function resolveUiLanguage(): WebEditorUiLanguage {
  const configured = useWorkspaceStore.getState().globalSettings?.uiLanguage;
  const language = configured || i18next.resolvedLanguage || i18next.language;
  return language === "ja" || language?.startsWith("ja-") ? "ja" : "en";
}

export interface DownloadHostedEditorHandoffDependencies {
  flushAllAutoSaves: typeof flushAllAutoSaves;
  registeredSaveHandlerIds: typeof registeredSaveHandlerIds;
  saveScene: typeof saveScene;
  awaitAllPendingSceneWrites: typeof awaitAllPendingSceneWrites;
  getHostedEditorRuntime: () => Pick<
    NonNullable<ReturnType<typeof getHostedEditorRuntime>>,
    "exportWorkspace"
  > | null;
  getCurrentProjectId: typeof getCurrentProjectId;
  getProject: (
    projectId: string,
  ) => Promise<{ title: string } | null | undefined>;
  resolveUiLanguage: typeof resolveUiLanguage;
  saveTextFile: typeof saveTextFile;
  now: () => string;
}

const DEFAULT_DEPENDENCIES: DownloadHostedEditorHandoffDependencies = {
  flushAllAutoSaves,
  registeredSaveHandlerIds,
  saveScene,
  awaitAllPendingSceneWrites,
  getHostedEditorRuntime,
  getCurrentProjectId,
  getProject,
  resolveUiLanguage,
  saveTextFile,
  now: () => new Date().toISOString(),
};

async function flushHostedEditorWrites(
  dependencies: DownloadHostedEditorHandoffDependencies,
): Promise<void> {
  // Cancel every pending autosave timer and wait for in-flight saves first.
  // AutoSave reports its own failures and leaves the editor dirty, so retry
  // dirty live editors through the strict save registry before taking a DB
  // snapshot. A persistent save failure therefore aborts the handoff.
  await dependencies.flushAllAutoSaves();
  await Promise.all(
    dependencies
      .registeredSaveHandlerIds()
      .map((sceneId) => dependencies.saveScene(sceneId)),
  );
  await dependencies.awaitAllPendingSceneWrites();
}

/**
 * Flushes the browser workspace and downloads its canonical, versioned
 * handoff. The optional `grimodex://handoff` launch signal is intentionally
 * separate and never contains manuscript data or a local path.
 */
export async function downloadHostedEditorHandoff(
  dependencies: DownloadHostedEditorHandoffDependencies = DEFAULT_DEPENDENCIES,
): Promise<string> {
  const runtime = dependencies.getHostedEditorRuntime();
  if (!runtime) {
    throw new Error("The hosted Editor runtime is not available.");
  }

  await flushHostedEditorWrites(dependencies);

  const projectId = dependencies.getCurrentProjectId();
  const project = await dependencies.getProject(projectId);
  if (!project) {
    throw new Error("The current project could not be found.");
  }

  const databaseBytes = await runtime.exportWorkspace();
  const handoff = buildWebEditorWorkspaceHandoff({
    databaseBytes,
    createdAt: dependencies.now(),
    sourceMode: "standalone",
    uiLanguage: dependencies.resolveUiLanguage(),
    projectId,
    title: project.title,
  });
  const filename = buildWebEditorHandoffFilename(project.title);
  const saved = await dependencies.saveTextFile(
    filename,
    {
      name: "Grimodex Web Editor handoff",
      extensions: ["grimodex-handoff"],
    },
    JSON.stringify(handoff),
    "application/json",
  );
  if (!saved) throw new Error("The handoff download was canceled.");
  return filename;
}
