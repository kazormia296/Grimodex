/**
 * propose_setting_change（設計書 §5・§6、personal の段）。
 *
 * 目録（`electron/shared/agentSettingCatalog.ts`）のキーと値を検証し、通ったものを「提案」として返すだけで、
 * 設定は変えない。chat のカードが前後の値と「適用」「却下」を出し、適用は利用者のクリックだけで行う。
 * `ai.autoAcceptBodyProposals` など自動適用の設定には影響されない（この経路は自動適用を持たない）。
 *
 * font の値は形だけ検証し、端末のフォント（システムフォント）は参照しない。モデルへの成功・失敗が
 * 端末の状態で変わって provider へ漏れないようにするためで、選択肢との照合は適用の時点で行う。
 *
 * 実行の前に AI ポリシーの chat が off なら拒否する。実装本体（目録・フォント列挙・適用）は
 * 初回の呼び出しまで読み込まない。
 */
import type { SettingProposal, ToolResult } from "./agentTypes";
import { countTokens } from "../contextBuilder";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";

type ToolReturn = Omit<ToolResult, "toolCallId">;

const TOOL_NAME = "propose_setting_change";
/** 理由の表示上限（超えた分は切る。値の検証とは無関係）。 */
export const MAX_SETTING_REASON_LENGTH = 200;

function fail(message: string, content: Record<string, unknown>): ToolReturn {
  return {
    name: TOOL_NAME,
    content,
    summary: message,
    tokensUsed: countTokens(JSON.stringify(content)),
    error: message,
  };
}

export async function proposeSettingChangeTool(
  params: Record<string, unknown>,
): Promise<ToolReturn> {
  if (blockIfPolicyOff("chat")) {
    return fail("AI chat policy is off", {
      error:
        "The AI chat policy is off for this project. Nothing was proposed.",
    });
  }
  const { AGENT_SETTING_KEYS } =
    await import("@/../electron/shared/agentSettingCatalog");
  const { validateSettingProposal } =
    await import("@/features/settings/agentSettingApply");
  const key = params["key"];
  // font は形だけ検証する（端末のフォントと照合しない）。選択肢との照合は利用者の「適用」の時点。
  const verdict = validateSettingProposal(key, params["value"]);
  if (!verdict.ok) {
    return fail(
      verdict.code === "unknown-key"
        ? "Setting is not available for proposals"
        : `Invalid value: ${verdict.message}`,
      {
        error: verdict.message,
        ...(verdict.code === "unknown-key"
          ? {
              allowedKeys: AGENT_SETTING_KEYS,
              hint: "Only these settings can be proposed. For any other setting, tell the user where it is in the settings screen instead (get_app_help_index).",
            }
          : {}),
      },
    );
  }
  const rawReason = params["reason"];
  const reason =
    typeof rawReason === "string" && rawReason.trim().length > 0
      ? rawReason.trim().slice(0, MAX_SETTING_REASON_LENGTH)
      : undefined;
  const proposal: SettingProposal = {
    id: crypto.randomUUID(),
    key: verdict.key,
    value: verdict.value,
    ...(reason ? { reason } : {}),
  };
  const content = {
    status: "proposed",
    key: proposal.key,
    proposedValue: proposal.value,
    note: "A card with Apply and Dismiss buttons was shown to the user. The setting has NOT been changed. Only the user's click applies it; do not say it is applied, and do not propose it again unless asked.",
  };
  return {
    name: TOOL_NAME,
    content,
    summary: `Proposed ${proposal.key} = ${proposal.value} (awaiting user)`,
    tokensUsed: countTokens(JSON.stringify(content)),
    settingProposal: proposal,
  };
}
