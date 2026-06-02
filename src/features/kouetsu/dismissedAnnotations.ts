import type {
  PostEffectAnnotation,
  PostEffectCategory,
} from "@/features/post-effect/types";

/**
 * annotation が「手動で無視 (dismiss) された」ものかを判定する。
 *
 * dismiss_source は status 更新時に Rust 側 (update_annotation_status) が
 * metadata に立てる: 手動 dismiss = "manual" / cascade 連鎖 = "cascade"。
 * resolved では立たない。metadata は string(JSON) / object どちらの形でも来る。
 *
 * codex_ref が存在する場合はそのネスト下の dismiss_source を優先して見る
 * (整合性 annotation は codex 参照情報を codex_ref に畳んで持つため)。
 */
export function isManualDismiss(ann: PostEffectAnnotation): boolean {
  try {
    const meta =
      typeof ann.metadata === "string"
        ? (JSON.parse(ann.metadata) as Record<string, unknown>)
        : (ann.metadata as Record<string, unknown>);
    const inner =
      (meta.codex_ref as Record<string, unknown> | undefined) ?? meta;
    return inner.dismiss_source === "manual";
  } catch {
    return false;
  }
}

/**
 * 指定 category の手動 dismiss 済み annotation だけを抽出する。
 *
 * 除外 (ignored) ビューが category を渡さず全件を描画すると、整合性 / 誤字脱字 /
 * レビュー / 疑似コメントの各セクションが byte 同一のリストを出してしまう。
 * category で絞ることで各セクションが自分の種別だけを表示する。
 */
export function selectManuallyDismissed(
  annotations: PostEffectAnnotation[],
  category: PostEffectCategory,
): PostEffectAnnotation[] {
  return annotations.filter(
    (a) => a.category === category && isManualDismiss(a),
  );
}
