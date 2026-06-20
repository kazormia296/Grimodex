import { buildVsInstruction, type VsLang } from "@/lib/verbalizedSampling";

/**
 * スラッシュコマンド → 送信時に L6 (commandInstruction) へ一回限り注入する指示文。
 *
 * 現状 VS を当てるのは発散コマンドの `/brainstorm` のみ。`/continue` `/rewrite`
 * `/translate` などは「典型的で流暢な答え」が欲しい面なので mode collapse は
 * むしろ味方であり、VS を当てない (undefined を返す)。
 *
 * チャットは生テキストを人が読むため emitProbability=false (確率の数値は出させず、
 * 裾からのサンプリングのみ内部で行わせる)。収束 (選別) は人間が Extract-to-Codex
 * 等で行う前提。
 */
export function buildChatCommandInstruction(
  commandId: string | null,
  lang: VsLang,
  opts?: { cot?: boolean },
): string | undefined {
  if (commandId === "brainstorm") {
    return buildVsInstruction(lang, {
      threshold: 0.1,
      cot: opts?.cot ?? true,
      emitProbability: false,
    });
  }
  return undefined;
}
