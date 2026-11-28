import type { AiFeature } from "./types";

/**
 * 書き込みの門が止めた例外。message はモデルに返す固定の英語で、画面の行の文は
 * 失敗を処理する側が理由から作る。門（policyGuard）を差し替える試験の影響を
 * 受けないように、依存を持たない。
 */
export class AiPolicyWriteBlockedError extends Error {
  constructor(
    readonly feature: AiFeature,
    message = `${feature} policy is off`,
  ) {
    super(message);
  }
}
