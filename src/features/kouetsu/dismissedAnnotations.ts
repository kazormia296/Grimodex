import type {
  PostEffectAnnotation,
  PostEffectCategory,
} from "@/features/post-effect/types";

/**
 * annotation が「手動で無視 (dismiss) された」ものかを判定する。
 *
 * dismiss_source は status 更新時に Rust 側 (update_annotation_status) が
 * metadata の **top-level** に立てる: 手動 dismiss = "manual" / cascade 連鎖 =
 * "cascade"。resolved では立たない。metadata は string(JSON) / object 両方来る。
 *
 * 旧実装は codex_ref があるとそのネスト下「だけ」を見ていたため、codex_ref を持つ
 * 整合性 (consistency_anchor) annotation で top-level の "manual" を取りこぼし、
 * 整合性の除外ビューが常に空になっていた。Rust の書き込み先である top-level を
 * 権威とし、念のため codex_ref 下の legacy 値も許容する。
 */
export function isManualDismiss(ann: PostEffectAnnotation): boolean {
  try {
    const meta =
      typeof ann.metadata === "string"
        ? (JSON.parse(ann.metadata) as Record<string, unknown>)
        : (ann.metadata as Record<string, unknown>);
    const codexRef = meta.codex_ref as Record<string, unknown> | undefined;
    return (
      meta.dismiss_source === "manual" || codexRef?.dismiss_source === "manual"
    );
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
