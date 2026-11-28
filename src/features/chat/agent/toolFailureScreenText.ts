import { aiPolicyStopText } from "@/features/ai-policy/policyGuard";
import { AiPolicyWriteBlockedError } from "@/features/ai-policy/writeBlockedError";

/**
 * tool の失敗を会話の画面の行（`summary`）に出す文。利用方針が壊れた作品と
 * 作品の未読込では確認済みの文を出し、モデルに返す `error` は変えない。
 */
export function toolFailureScreenText(e: unknown, message: string): string {
  return (
    (e instanceof AiPolicyWriteBlockedError && aiPolicyStopText(e.feature)) ||
    message
  );
}
