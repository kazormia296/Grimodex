/**
 * codexYomi.ts — 漢字を含む Codex 表記の読み(ふりがな)を LLM で推定する (IME連携 Phase1)。
 *
 * candidateJudgment.judgeCandidates と同じ single-shot パターン:
 * resolveRoleSendOverride → getPromptCatalog().codexYomi.buildYomiEstimationPrompt →
 * sendChatMessageWithThinking → extractJsonObject + 型ガード。推定結果は readings 列へ
 * 即保存する (承認フロー無し。誤りは編集 UI で訂正 = docs §3.3)。
 *
 * 推定は「エントリ単位でバッチ」= N エントリを 1 プロンプトに畳む (1件1コールにしない)。
 * 大量件はバックフィル側で MAX_ENTRIES ごとに chunk して逐次 await する。
 */
import { sendChatMessageWithThinking } from "@/features/chat/chatApi";
import { resolveRoleSendOverride } from "@/features/chat/modelRouting";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { getPromptCatalog } from "@/prompts/index";
import { extractJsonObject } from "@/prompts/shared/jsonContract";
import { useTreeStore } from "@/features/tree/treeStore";
import { getProject } from "@/features/project/api";
import { normalizeReading, isHiraganaReading } from "./reading";

/** 1 表記の推定結果。yomi はひらがな正規化済み。 */
export interface YomiResult {
  surface: string;
  yomi: string;
}

/** 読みを推定したい表記を持つエントリ。surfaces は漢字を含む未確定表記のみ渡す。 */
export interface YomiEstimationEntry {
  id: string;
  /** 表示用カテゴリラベル (読みの曖昧性解消ヒント)。 */
  category: string;
  surfaces: string[];
}

// 1 リクエストの上限。バックフィルはこの単位で chunk する。
export const YOMI_MAX_ENTRIES = 100;

/**
 * エントリ群の漢字表記の読みを一括推定する。
 * policy off / 入力なし / AI 失敗時は空 Map (呼び出し側は既存 readings を保つ)。
 * 返り値: entry id → [{surface, yomi}]。
 */
export async function inferReadings(
  entries: ReadonlyArray<YomiEstimationEntry>,
): Promise<Map<string, YomiResult[]>> {
  const result = new Map<string, YomiResult[]>();
  // 読みを Codex へ即書き込むため knowledgeWrite で gate する。
  if (blockIfPolicyOff("knowledgeWrite")) return result;

  const targets = entries
    .map((e) => ({ ...e, surfaces: e.surfaces.filter((s) => s.trim()) }))
    .filter((e) => e.surfaces.length > 0)
    .slice(0, YOMI_MAX_ENTRIES);
  if (targets.length === 0) return result;

  let lang = "ja";
  try {
    const project = await getProject(useTreeStore.getState().projectId);
    lang = project?.language ?? "ja";
  } catch {
    // ignore — ja 既定
  }

  // hallucination 照合先: id → その id で許可された surface 集合。
  const validSurfacesById = new Map<string, Set<string>>(
    targets.map((e) => [e.id, new Set(e.surfaces)]),
  );

  const prompt = getPromptCatalog(lang).codexYomi.buildYomiEstimationPrompt({
    entries: targets.map((e) => ({
      id: e.id,
      category: e.category,
      surfaces: e.surfaces,
    })),
  });

  let response;
  try {
    const ov = resolveRoleSendOverride("codex_yomi");
    response = await sendChatMessageWithThinking(
      [{ role: "user", content: prompt }],
      undefined, // thinkingParams
      undefined, // systemCacheSegments
      ov.apiVariant, // apiVariant（横断割り当て時のみ）
      undefined, // systemVolatileTail
      ov.model,
      ov.provider,
      ov.endpointId,
    );
  } catch {
    return result;
  }
  void recordAiUsage({
    surface: "codex_yomi",
    tokensIn: response.inputTokens,
    tokensOut: response.outputTokens,
  });

  return parseYomiResponse(response.text, validSurfacesById);
}

/**
 * LLM 応答テキストから読みを抽出・検証して `id → [{surface, yomi}]` にする純関数。
 * **本番経路 (inferReadings) と live 品質テストの双方がこれを使う**ことでパーサの
 * ドリフトを防ぐ。型ガード:
 * - id は入力に在るものだけ (hallucination 棄却)。
 * - surface はその id で許可された表記だけ (捏造・取り違え棄却)。
 * - yomi は normalizeReading でひらがな化。空・漢字残り (表記のエコー) は棄却。
 * - 同一 (id, surface) の重複は最初の 1 件を採用。
 */
export function parseYomiResponse(
  responseText: string,
  validSurfacesById: Map<string, Set<string>>,
): Map<string, YomiResult[]> {
  const result = new Map<string, YomiResult[]>();
  const jsonText = extractJsonObject(responseText);
  if (!jsonText) return result;
  let parsed: { readings?: unknown };
  try {
    parsed = JSON.parse(jsonText) as { readings?: unknown };
  } catch {
    return result;
  }
  if (!Array.isArray(parsed.readings)) return result;

  // (id, surface) 重複の最初勝ち用。id ごとに採用済み surface 集合を持つ
  // (区切り文字連結を避け、キー衝突・制御文字混入のリスクを無くす)。
  const seenByEntry = new Map<string, Set<string>>();
  for (const raw of parsed.readings) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.surface !== "string") continue;
    if (typeof r.yomi !== "string") continue;
    const allowed = validSurfacesById.get(r.id);
    if (!allowed || !allowed.has(r.surface)) continue; // 未知 id / 取り違え surface
    const yomi = normalizeReading(r.yomi);
    // AI 対象 surface は必ず漢字を含む＝正しい読みは常にかな。空・漢字残り(表記
    // エコー)・ローマ字/数字/記号/カタカナ残渣を弾き、きれいなひらがな読みのみ採用。
    if (!isHiraganaReading(yomi)) continue;
    let seen = seenByEntry.get(r.id);
    if (!seen) {
      seen = new Set<string>();
      seenByEntry.set(r.id, seen);
    }
    if (seen.has(r.surface)) continue;
    seen.add(r.surface);
    const list = result.get(r.id) ?? [];
    list.push({ surface: r.surface, yomi });
    result.set(r.id, list);
  }
  return result;
}
