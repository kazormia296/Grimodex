/**
 * candidateExtractor.ts — Rust の `extract_codex_candidates` コマンドの薄い
 * invoke ラッパ。本文中の「未知の固有名詞 (既存 Codex に無いもの)」候補を返す。
 * 非 Tauri 環境 (ブラウザ/テスト) では空配列を返す ([[rustMatcher]] と同形)。
 */
import { invoke } from "@/lib/tauri";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Rust から返る未確定固有名詞候補 (camelCase へ自動変換済)。 */
export interface CodexCandidate {
  /** 代表表層形 (読書順で最初の出現)。 */
  surface: string;
  /** UniDic 語彙素 (空なら surface)。 */
  lemma: string;
  /** プロジェクト全体での総出現数。 */
  count: number;
  /** 読書順で最初に出現したシーン。 */
  firstSceneId: string;
  /** そのシーン平文内のバイトオフセット。 */
  firstByteOffset: number;
}

/**
 * 未知の固有名詞候補を抽出する。`minCount` 未満の出現は除外 (既定 2)。
 * 日本語以外のプロジェクトでは空が返る (Rust 側でゲート)。
 */
export async function extractCodexCandidates(
  projectId: string,
  minCount?: number,
): Promise<CodexCandidate[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<CodexCandidate[]>("extract_codex_candidates", {
      projectId,
      minCount: minCount ?? null,
    });
  } catch {
    return [];
  }
}
