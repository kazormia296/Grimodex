/**
 * codexCandidateDismissals.ts — 「未確定の固有名詞候補」(CodexCandidatesReport) を
 * 「却下 (dismiss)」した状態をプロジェクト単位で永続化する。
 *
 * 候補は本文を都度スキャンして得る揮発データで DB レコードを持たない (まだ Codex
 * エントリではない)。よって却下は候補の安定キー (正規化表層) 集合として
 * project_settings に JSON 配列で保存する。エントリに紐づかないため FK cascade が
 * 引けず、project スコープの KV が素直 ([[codexIntegrityDismissals]] と同設計)。
 *
 * 集合が空になったら行ごと削除して掃除する。スナップショット (AUX_SCOPES) には
 * **含めない** — 「どの候補を見送ったか」は作業者の承認状態でありコンテンツでない。
 */
import {
  getProjectSetting,
  setProjectSetting,
  deleteProjectSetting,
} from "@/features/settings/api";

/** project_settings のキー。 */
export const DISMISSED_CANDIDATES_KEY = "codex.candidates.dismissed";

/**
 * このプロジェクトで却下した候補のキー集合を読む。
 * 行が無い / JSON が壊れている場合は空集合 (fail-safe — 候補は出す方に倒す)。
 */
export async function loadDismissedCandidateKeys(
  projectId: string,
): Promise<Set<string>> {
  const raw = await getProjectSetting(projectId, DISMISSED_CANDIDATES_KEY);
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
 * 却下キー集合を丸ごと保存する (UI 側が保持する集合を権威として全置換)。
 * 空集合なら行を削除する。決定的なシリアライズのため sort する。
 */
export async function saveDismissedCandidateKeys(
  projectId: string,
  keys: Set<string>,
): Promise<void> {
  if (keys.size === 0) {
    await deleteProjectSetting(projectId, DISMISSED_CANDIDATES_KEY);
    return;
  }
  await setProjectSetting(
    projectId,
    DISMISSED_CANDIDATES_KEY,
    JSON.stringify([...keys].sort()),
  );
}
