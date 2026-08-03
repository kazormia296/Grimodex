import type { PostEffectAnnotation } from "./types";

export interface LiveReaderAnnotationInput {
  annotationId: string;
  projectId: string;
  sceneId: string;
  runId: string;
  model: string;
  content: string;
  persona: string | null;
  foundText: string;
  foundContext: string;
  createdAt: string;
}

function metadataObject(
  annotation: PostEffectAnnotation,
): Record<string, unknown> {
  if (typeof annotation.metadata !== "string") {
    return (annotation.metadata as Record<string, unknown> | null) ?? {};
  }
  try {
    const parsed: unknown = JSON.parse(annotation.metadata);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 同じ pseudo_comment 型の中で、ライブ生成由来かを判別する永続マーカー。 */
export function isLiveReaderAnnotation(
  annotation: PostEffectAnnotation,
): boolean {
  return (
    annotation.category === "pseudo_comment" &&
    metadataObject(annotation).live === true
  );
}

/** partial イベントを annotation store/本文 mark に載せられる形へ変換する。 */
export function buildLiveReaderAnnotation(
  input: LiveReaderAnnotationInput,
): PostEffectAnnotation {
  const foundText = input.foundText.trim();
  const foundContext = input.foundContext.trim();
  const metadata = {
    live: true,
    persona: input.persona,
    found_text: foundText,
    found_context: foundContext,
    detected_by_model: input.model,
    orphaned: foundText.length === 0,
  };
  return {
    id: input.annotationId,
    projectId: input.projectId,
    runId: input.runId,
    anchorType: "scene_range",
    sceneId: input.sceneId,
    // live run は近傍コンテキストだけを Rust へ渡すため、PM 側で mark を解決し、
    // 次の autosave で正確な range を同期する。初期値は resolver の hint 用。
    rangeStart: 0,
    rangeEnd: 0,
    textSnapshot: foundText || null,
    category: "pseudo_comment",
    persona: input.persona,
    severity: null,
    content: input.content,
    authorRole: "ai",
    parentId: null,
    status: "open",
    metadata: JSON.stringify(metadata),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}
