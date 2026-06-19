/**
 * codexIntegrityDismissals.ts — Codex 内部整合チェッカー (CodexIntegrityReport) の
 * 指摘を「非表示 (dismiss)」にした状態をプロジェクト単位で永続化する。
 *
 * integrity の指摘 (別名衝突・重複/自己参照リレーション) は entries/relations から
 * 都度再計算される揮発データで DB レコードを持たない。よって dismiss は
 * `integrityIssueKey()` の安定キー集合として project_settings に JSON 配列で保存する
 * (codex_dismissed_relations の様な専用テーブルは不要 — alias 衝突は entry に紐づかず
 * FK cascade が引けないため、project スコープの KV が素直)。
 *
 * 集合が空になったら行ごと削除して掃除する。
 *
 * スナップショット注意: project_settings はプロジェクトスナップショット (AUX_SCOPES) に
 * **含めない**。非表示は「どの警告を確認済みとしたか」という作業者の承認状態であって、
 * 本文・Codex のようなコンテンツではないため、スナップショットの巻き戻しで一緒に
 * 戻すべきではない (aiPrompt.custom など他の project_settings KV と同じ扱い)。永続自体は
 * 同テーブル=プロジェクト DB に残り、DB 丸ごとのバックアップでは保たれる。
 */
import {
  getProjectSetting,
  setProjectSetting,
  deleteProjectSetting,
} from "@/features/settings/api";

/** project_settings のキー。 */
export const DISMISSED_INTEGRITY_KEY = "codex.integrity.dismissed";

/**
 * このプロジェクトで非表示にした integrity 指摘のキー集合を読む。
 * 行が無い / JSON が壊れている場合は空集合 (fail-safe — 警告は出る方に倒す)。
 */
export async function loadDismissedIntegrityKeys(
  projectId: string,
): Promise<Set<string>> {
  const raw = await getProjectSetting(projectId, DISMISSED_INTEGRITY_KEY);
  if (!raw) return new Set();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

/**
 * 非表示キー集合を丸ごと保存する (read-modify-write の競合を避けるため UI 側が保持する
 * 集合を権威として全置換する)。空集合なら行を削除する。
 */
export async function saveDismissedIntegrityKeys(
  projectId: string,
  keys: Set<string>,
): Promise<void> {
  if (keys.size === 0) {
    await deleteProjectSetting(projectId, DISMISSED_INTEGRITY_KEY);
    return;
  }
  // 決定的なシリアライズのため sort する (同じ集合 → 同じ文字列。手動でテーブルを
  // 覗いたときの可読性にも効く)。順序は読み取り時に Set へ畳むので意味は持たない。
  await setProjectSetting(
    projectId,
    DISMISSED_INTEGRITY_KEY,
    JSON.stringify([...keys].sort()),
  );
}
