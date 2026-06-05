import type { PostEffectAnnotation } from "./types";
import {
  parseAnnotationMeta,
  type ParsedAnnotationMeta,
} from "./annotationMeta";

export interface ConsistencyFinding {
  annotation: PostEffectAnnotation;
  meta: ParsedAnnotationMeta;
}

/**
 * Codex エントリ (entry_id) を join key に、本文側の整合性指摘
 * (category=consistency_anchor / metadata.codex_ref.entry_id) を引く。
 *
 * Tier A-1: 生成側・スキーマ不変の read-only surfacing。Codex 詳細に
 * 「この設定に矛盾する本文指摘 N 件」を出すための純関数。
 */
export function selectConsistencyFindingsForEntry(
  annotations: PostEffectAnnotation[],
  entryId: string,
): ConsistencyFinding[] {
  if (!entryId) return [];
  const out: ConsistencyFinding[] = [];
  for (const ann of annotations) {
    const meta = parseAnnotationMeta(ann);
    if (meta.kind === "consistency" && meta.codex?.entryId === entryId) {
      out.push({ annotation: ann, meta });
    }
  }
  return out;
}
