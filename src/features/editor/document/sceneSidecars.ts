import type { Editor } from "@tiptap/core";
import * as attributionApi from "@/features/attribution/api";
import * as foreshadowApi from "@/features/foreshadow/saveAnchors";
import * as annotationApi from "@/features/post-effect/api";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import { applyAnnotationsToEditor } from "@/features/post-effect/applyAnnotationsToEditor";
import {
  clampMarkRange,
  resolveAnchorLoads,
  type ResolvedAnchorLoads,
} from "@/features/editor/anchorLoads";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { isD2aEgressDenied } from "@/lib/tauri";
import { markEnd, markStart } from "@/lib/perfLog";

export interface SceneSidecarServices {
  loadAuthorshipSpans: typeof attributionApi.loadAuthorshipSpans;
  loadForeshadowAnchors: typeof foreshadowApi.loadForeshadowAnchors;
  listAnnotationsForScene: typeof annotationApi.listAnnotationsForScene;
}

const defaultSceneSidecarServices: SceneSidecarServices = {
  loadAuthorshipSpans: (sceneId) => attributionApi.loadAuthorshipSpans(sceneId),
  loadForeshadowAnchors: (sceneId) =>
    foreshadowApi.loadForeshadowAnchors(sceneId),
  listAnnotationsForScene: (input) =>
    annotationApi.listAnnotationsForScene(input),
};

export async function loadSceneSidecars(
  sceneId: string,
  projectId: string,
  services: SceneSidecarServices = defaultSceneSidecarServices,
): Promise<ResolvedAnchorLoads> {
  markStart("sceneLoad.loadAnchors.parallel");
  const [spansR, foreshadowR, annotationR] = await Promise.allSettled([
    services.loadAuthorshipSpans(sceneId),
    services.loadForeshadowAnchors(sceneId),
    services.listAnnotationsForScene({ projectId, sceneId }),
  ]);
  markEnd("sceneLoad.loadAnchors.parallel");
  return resolveAnchorLoads(spansR, foreshadowR, annotationR);
}

export function applySceneSidecars(
  editor: Editor,
  sceneId: string,
  sidecars: ResolvedAnchorLoads,
  isCancelled: () => boolean,
): void {
  // A workspace switch can finish the old DB reads after the new document is
  // already being loaded. Drop the entire stale projection, including its
  // diagnostics and store hydration; logging the rejected old reads here made
  // a normal switch look like a live workspace failure.
  if (isCancelled()) return;

  for (const { label, reason } of sidecars.errors) {
    if (isD2aEgressDenied(reason)) continue;
    debugLog.error(
      "EditorPane",
      `sceneLoad.loadAnchors:${label} failed`,
      errorDetail(reason),
    );
  }

  if (!isCancelled()) {
    const markData =
      sidecars.spans.length > 0
        ? attributionApi.spansToMarkData(sidecars.spans)
        : [];
    const authorshipType = editor.schema.marks["authorship"];
    const willApplyAuthorship = markData.length > 0 && !!authorshipType;
    const willApplyForeshadow = sidecars.foreshadowMarks.length > 0;

    if (willApplyAuthorship || willApplyForeshadow) {
      markStart(
        `sceneLoad.applyAnchorMarks.${markData.length}+${sidecars.foreshadowMarks.length}`,
      );
      editor
        .chain()
        .command(({ tr }) => {
          tr.setMeta("programmaticInsert", true);
          if (willApplyAuthorship) {
            for (const { from, to, attrs } of markData) {
              const range = clampMarkRange(from, to, tr.doc.content.size);
              if (range) {
                tr.addMark(range.from, range.to, authorshipType!.create(attrs));
              }
            }
          }
          if (willApplyForeshadow) {
            foreshadowApi.clearAllForeshadowMarks((fn) => fn(tr));
            const schema = tr.doc.type.schema;
            for (const {
              from,
              to,
              markName,
              attrs,
            } of sidecars.foreshadowMarks) {
              const markType = schema.marks[markName];
              if (!markType) continue;
              const range = clampMarkRange(from, to, tr.doc.content.size);
              if (range)
                tr.addMark(range.from, range.to, markType.create(attrs));
            }
          }
          return true;
        })
        .run();
      markEnd(
        `sceneLoad.applyAnchorMarks.${markData.length}+${sidecars.foreshadowMarks.length}`,
      );
    }
  }

  // Store hydration intentionally remains unconditional for compatibility with
  // the previous EditorPane behavior; only editor dispatch is cancellation-gated.
  if (sidecars.annotations) {
    useAnnotationStore.getState().setFocusedAnnotationId(null);
    useAnnotationStore
      .getState()
      .setAnnotations(sceneId, sidecars.annotations.annotations);
    if (!isCancelled()) {
      applyAnnotationsToEditor(editor, sidecars.annotations.annotations);
    }
  }
}
