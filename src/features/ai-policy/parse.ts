import { DEFAULT_AI_POLICY } from "./types";
import { expandPreset } from "./preset";
import type { AiPolicy, AiPolicyPreset, AiPolicyToggles } from "./types";

const VALID_PRESETS = new Set<AiPolicyPreset>([
  "full",
  "assist-off",
  "review-only",
  "off",
  "custom",
]);

// 後方互換: 旧 policy JSON は structureWrite を持たないため、ここは意図的に
// 3 レガシーキー(chat/bodyWrite/analysis)の存在のみを要求する。structureWrite を
// 必須にすると既存プロジェクトの policy が丸ごと DEFAULT に倒れて preset を失う。
// 欠損 structureWrite は parseAiPolicy 内で stored preset から導出する。
function isValidToggles(
  v: unknown,
): v is Pick<AiPolicyToggles, "chat" | "bodyWrite" | "analysis"> {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return "chat" in obj && "bodyWrite" in obj && "analysis" in obj;
}

export function parseAiPolicy(raw: string | null | undefined): AiPolicy {
  if (!raw) return { ...DEFAULT_AI_POLICY };
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const preset = obj.preset as AiPolicyPreset;
    if (!VALID_PRESETS.has(preset)) return { ...DEFAULT_AI_POLICY };
    if (!isValidToggles(obj.toggles)) return { ...DEFAULT_AI_POLICY };
    const t = obj.toggles as unknown as Record<string, unknown>;
    // 欠損 structureWrite(旧 JSON)の扱い。named preset は preset の契約値を採用する。
    // ただし preset==="custom" は「どの named preset にも一致しない手組みトグル」で
    // あり、structureWrite が存在しなかった当時に同意された値が無い。ここを
    // expandPreset("custom")=full に倒すと、AI を絞っていた custom ユーザーが
    // アップグレードで structureWrite を黙って獲得する fail-open になる(H1)。
    // よって custom の欠損だけは保守的に false(=未許可)へ倒す。
    const structureWrite =
      "structureWrite" in t
        ? Boolean(t.structureWrite)
        : preset === "custom"
          ? false
          : expandPreset(preset).structureWrite;
    const knowledgeWrite =
      "knowledgeWrite" in t
        ? Boolean(t.knowledgeWrite)
        : preset === "custom"
          ? false
          : expandPreset(preset).knowledgeWrite;
    return {
      preset,
      toggles: {
        chat: Boolean(t.chat),
        bodyWrite: Boolean(t.bodyWrite),
        analysis: Boolean(t.analysis),
        structureWrite,
        knowledgeWrite,
      },
    };
  } catch {
    return { ...DEFAULT_AI_POLICY };
  }
}

export function serializeAiPolicy(policy: AiPolicy): string {
  return JSON.stringify(policy);
}

/**
 * 本文書き込み (bodyWrite) がポリシーで無効かどうか。
 *
 * 不正・未設定のポリシーは DEFAULT_AI_POLICY (bodyWrite: true) に倒れるため
 * `false` (= 無効ではない / 代筆許可) を返す fail-open。チャット system prompt
 * の本文代筆抑止指示を出すかどうかの判定に使う。
 */
export function isBodyWriteDisabled(raw: string | null | undefined): boolean {
  return !parseAiPolicy(raw).toggles.bodyWrite;
}
