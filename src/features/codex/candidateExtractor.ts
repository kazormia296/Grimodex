/**
 * candidateExtractor.ts — Rust の `extract_codex_candidates` コマンドの薄い
 * invoke ラッパ。本文中の「未知の固有名詞 (既存 Codex に無いもの)」候補を返す。
 * 非ネイティブ環境 (ブラウザ/テスト) では空配列を返す ([[rustMatcher]] と同形)。
 */
import { isElectron } from "@/lib/shell";
import { invoke, isTauri } from "@/lib/tauri";

function supportsNativeCandidateExtraction(): boolean {
  return isTauri() || isElectron();
}

/** Rust から返る未確定固有名詞候補 (camelCase へ自動変換済)。 */
export interface CodexCandidate {
  /** 代表表層形 (読書順で最初の出現)。 */
  surface: string;
  /** UniDic 語彙素 (空なら surface)。 */
  lemma: string;
  /** プロジェクト全体での総出現数。 */
  count: number;
  /** 読書順で最初に出現したシーン (初出シーンへのジャンプ用)。 */
  firstSceneId: string;
  /** 初出箇所の周辺一文 (LLM 種別判定の文脈サンプル用)。 */
  context: string;
}

export type CodexCandidateScanResult =
  | { readonly ok: true; readonly candidates: CodexCandidate[] }
  | { readonly ok: false };

/**
 * 未知の固有名詞候補を抽出する。`minCount` 未満の出現は除外 (既定 2)。
 * 日本語以外のプロジェクトでは空が返る (Rust 側でゲート)。
 */
export async function extractCodexCandidatesResult(
  projectId: string,
  minCount?: number,
): Promise<CodexCandidateScanResult> {
  if (!supportsNativeCandidateExtraction()) return { ok: false };
  try {
    return {
      ok: true,
      candidates: await invoke<CodexCandidate[]>("extract_codex_candidates", {
        projectId,
        minCount: minCount ?? null,
      }),
    };
  } catch {
    return { ok: false };
  }
}

/** 既存呼び手向けの互換 API。失敗時はこれまでどおり空配列を返す。 */
export async function extractCodexCandidates(
  projectId: string,
  minCount?: number,
): Promise<CodexCandidate[]> {
  const result = await extractCodexCandidatesResult(projectId, minCount);
  return result.ok ? result.candidates : [];
}
