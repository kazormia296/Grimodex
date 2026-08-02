import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { useAnnotationStore } from "./annotationStore";
import { savePostEffectAnnotations } from "./api";
import { isLiveReaderAnnotation } from "./liveReaderAnnotation";

export interface AnnotationAnchor {
  id: string;
  rangeStart: number;
  rangeEnd: number;
  textSnapshot: string;
}

export function extractAnnotationMarks(
  _sceneId: string,
  doc: ProseMirrorNode,
): AnnotationAnchor[] {
  const byId = new Map<
    string,
    { rangeStart: number; rangeEnd: number; texts: string[] }
  >();

  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type.name === "peAnnotation");
    if (!mark) return;
    const id = mark.attrs.annotationId as string;
    if (!id) return;
    const len = node.text?.length ?? 0;
    const text = node.text ?? "";
    const existing = byId.get(id);
    if (existing) {
      existing.rangeEnd = pos + len;
      existing.texts.push(text);
    } else {
      byId.set(id, { rangeStart: pos, rangeEnd: pos + len, texts: [text] });
    }
  });

  return Array.from(byId.entries()).map(
    ([id, { rangeStart, rangeEnd, texts }]) => ({
      id,
      rangeStart,
      rangeEnd,
      textSnapshot: texts.join(""),
    }),
  );
}

export async function saveAnnotationAnchors(
  projectId: string,
  sceneId: string,
  doc: ProseMirrorNode,
): Promise<void> {
  const annotations = extractAnnotationMarks(sceneId, doc);
  const anchoredIds = new Set(annotations.map((annotation) => annotation.id));
  const sceneText = doc.textBetween(0, doc.content.size, "\n");
  // Closing a live comment removes its visible mark, but must not turn the
  // generated record into a missing-body deletion while its target remains (or
  // while it is an intentional scene-level comment without a text target).
  // Keep a hidden persistence anchor for those cases; the native body bundle
  // also verifies the text against the authoritative ProseMirror JSON.
  for (const annotation of useAnnotationStore
    .getState()
    .annotationsByScene.get(sceneId) ?? []) {
    if (
      !isLiveReaderAnnotation(annotation) ||
      anchoredIds.has(annotation.id) ||
      (annotation.textSnapshot !== null &&
        annotation.textSnapshot !== "" &&
        !sceneText.includes(annotation.textSnapshot))
    ) {
      continue;
    }
    annotations.push({
      id: annotation.id,
      rangeStart: annotation.rangeStart ?? 0,
      rangeEnd: annotation.rangeEnd ?? 0,
      textSnapshot: annotation.textSnapshot ?? "",
    });
  }
  await savePostEffectAnnotations({ projectId, sceneId, annotations });
}
