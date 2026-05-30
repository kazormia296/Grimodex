import { DEFAULT_AI_POLICY } from "./types";
import type { AiPolicy, AiPolicyPreset, AiPolicyToggles } from "./types";

const VALID_PRESETS = new Set<AiPolicyPreset>([
  "full",
  "assist-off",
  "review-only",
  "off",
  "custom",
]);

function isValidToggles(v: unknown): v is AiPolicyToggles {
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
    return {
      preset,
      toggles: {
        chat: Boolean(t.chat),
        bodyWrite: Boolean(t.bodyWrite),
        analysis: Boolean(t.analysis),
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
