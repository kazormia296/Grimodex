import * as codexApi from "@/features/codex/api";
import {
  resolveApplicablePhases,
  resolvePhaseEditState,
} from "@/features/codex/context/resolveApplicablePhases";
import type { PhaseResolutionMode } from "@/features/codex/phaseResolver";
import type { SceneTimeIndex } from "@/features/codex/context/sceneTimeIndex";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { markEnd, markStart } from "@/lib/perfLog";
import type { LoadedEditorBinding, LoadedEditorDocument } from "../types";

export interface CodexDocumentLoadServices {
  getCodexEntry: (
    projectId: string,
    id: string,
  ) => Promise<
    { content?: string | null; summary?: string | null } | undefined
  >;
  loadPhasesForEntry: (id: string) => Promise<void>;
  getPhasesForEntry: (
    id: string,
  ) => ReturnType<typeof usePhaseStore.getState>["phasesByEntry"][string];
  getCurrentProjectId: () => string;
}

export interface CodexDocumentLoadContext {
  phase: {
    mode: "base" | "explicit" | "auto";
    phaseId?: string;
    sceneId?: string | null;
  };
  sceneTimeIndex: SceneTimeIndex | null;
  resolutionMode: PhaseResolutionMode | null;
}

const defaultCodexDocumentLoadServices: CodexDocumentLoadServices = {
  getCodexEntry: (projectId, id) => codexApi.getCodexEntry(projectId, id),
  loadPhasesForEntry: (id) => usePhaseStore.getState().loadPhasesForEntry(id),
  getPhasesForEntry: (id) => usePhaseStore.getState().phasesByEntry[id] ?? [],
  getCurrentProjectId,
};

function parseCodexContent(
  raw: string | null | undefined,
): Record<string, unknown> | "" {
  if (!raw || raw === "{}") return "";
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function loadCodexDocument(
  binding: Extract<LoadedEditorBinding, { kind: "codex" }>,
  context: CodexDocumentLoadContext,
  services: CodexDocumentLoadServices = defaultCodexDocumentLoadServices,
): Promise<LoadedEditorDocument> {
  markStart("sceneLoad.getCodexEntry");
  const entry = await services.getCodexEntry(
    services.getCurrentProjectId(),
    binding.id,
  );
  markEnd("sceneLoad.getCodexEntry");

  await services.loadPhasesForEntry(binding.id);
  const phases = services.getPhasesForEntry(binding.id);
  let phaseContentOverride: string | null = null;
  let resolvedPhaseId: string | null = null;

  if (context.phase.mode === "explicit" && context.phase.phaseId) {
    const targetPhase = phases.find(
      (phase) => phase.id === context.phase.phaseId,
    );
    if (targetPhase && context.sceneTimeIndex && context.resolutionMode) {
      const resolution = resolveApplicablePhases({
        phases,
        index: context.sceneTimeIndex,
        mode: context.resolutionMode,
        anchor: { kind: "phase", phaseId: targetPhase.id },
      });
      phaseContentOverride = resolvePhaseEditState(resolution, {
        summary: entry?.summary ?? null,
        content: entry?.content ?? "{}",
      }).content;
      resolvedPhaseId = targetPhase.id;
    }
  } else if (context.phase.mode === "auto" && context.phase.sceneId) {
    if (context.sceneTimeIndex && context.resolutionMode) {
      const resolution = resolveApplicablePhases({
        phases,
        index: context.sceneTimeIndex,
        mode: context.resolutionMode,
        anchor: { kind: "scene", sceneId: context.phase.sceneId },
      });
      const editState = resolvePhaseEditState(resolution, {
        summary: entry?.summary ?? null,
        content: entry?.content ?? "{}",
      });
      if (editState.targetPhase) {
        phaseContentOverride = editState.content;
        resolvedPhaseId = editState.targetPhase.id;
      }
    }
  }

  const rawContent = phaseContentOverride ?? entry?.content ?? null;
  markStart("sceneLoad.parseContent.codex");
  const content = parseCodexContent(rawContent);
  markEnd("sceneLoad.parseContent.codex");

  return {
    binding: { ...binding, phaseId: resolvedPhaseId },
    content,
  };
}
