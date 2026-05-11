import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { savePostEffectAnnotations } from "./api";

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
  if (annotations.length === 0) return;
  await savePostEffectAnnotations({ projectId, sceneId, annotations });
}
