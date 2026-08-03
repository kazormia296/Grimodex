import {
  parseWebEditorWorkspaceHandoff,
  type WebEditorWorkspaceHandoffV1,
  type WebEditorWorkspaceHandoffValidationResult,
} from "@grimodex/scan-contract/web-editor-handoff";
import {
  openWebEditorHandoffFile,
  type OpenTextResult,
} from "@/lib/importFile";
import type { SaveFilter } from "@/lib/exportFile";
import { invoke } from "@/lib/tauri";
import { useWorkspaceStore } from "@/features/workspace/store";

const WEB_EDITOR_HANDOFF_FILTER: SaveFilter = {
  name: "Grimodex Web Editor handoff",
  extensions: ["grimodex-handoff"],
};

interface ImportedWorkspace {
  path: string;
  projectId: string;
}

interface WebEditorWorkspaceImportDependencies {
  openTextFile: (filter: SaveFilter) => Promise<OpenTextResult | null>;
  parseHandoff: (input: unknown) => WebEditorWorkspaceHandoffValidationResult;
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>;
  openWorkspace: (path: string) => Promise<void>;
}

export type WebEditorWorkspaceImportResult =
  | { status: "canceled" }
  | {
      status: "imported";
      fileName: string;
      handoff: WebEditorWorkspaceHandoffV1;
      path: string;
      projectId: string;
    };

const DEFAULT_DEPENDENCIES: WebEditorWorkspaceImportDependencies = {
  openTextFile: openWebEditorHandoffFile,
  parseHandoff: parseWebEditorWorkspaceHandoff,
  invoke,
  openWorkspace: async (path) => {
    await useWorkspaceStore.getState().openWorkspace(path);
    const state = useWorkspaceStore.getState();
    if (state.view !== "editor" || state.activeWorkspacePath !== path) {
      throw new Error(
        state.error || "Grimodex could not open the imported workspace.",
      );
    }
    if (!state.globalSettings?.hasSeenWelcome) {
      await useWorkspaceStore
        .getState()
        .updateGlobalSettings({ hasSeenWelcome: true });
    }
  },
};

/**
 * Imports the explicit, versioned Web Editor handoff format. Generic project
 * imports deliberately stay on their existing path; this entry point accepts
 * only `.grimodex-handoff` and asks the native core to validate/materialize it.
 */
export async function importWebEditorWorkspaceHandoff(
  dependencies: WebEditorWorkspaceImportDependencies = DEFAULT_DEPENDENCIES,
): Promise<WebEditorWorkspaceImportResult> {
  const selected = await dependencies.openTextFile(WEB_EDITOR_HANDOFF_FILTER);
  if (!selected) return { status: "canceled" };

  let input: unknown;
  try {
    input = JSON.parse(selected.content) as unknown;
  } catch (cause) {
    throw new Error("The Web Editor handoff must contain valid JSON.", {
      cause,
    });
  }

  const parsed = dependencies.parseHandoff(input);
  if (!parsed.ok) {
    const details = parsed.errors
      .map((item) => `${item.path}: ${item.message}`)
      .join("; ");
    throw new Error(`Invalid Web Editor handoff: ${details}`);
  }

  const imported = (await dependencies.invoke("import_web_editor_workspace", {
    handoffJson: selected.content,
  })) as ImportedWorkspace;
  if (
    !imported ||
    typeof imported.path !== "string" ||
    imported.path.length === 0 ||
    imported.projectId !== parsed.value.projectId
  ) {
    throw new Error("The native Web Editor import returned an invalid result.");
  }
  await dependencies.openWorkspace(imported.path);

  return {
    status: "imported",
    fileName: selected.name,
    handoff: parsed.value,
    path: imported.path,
    projectId: imported.projectId,
  };
}
