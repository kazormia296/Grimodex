import type { AiFeature } from "@/features/ai-policy/types";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";

/**
 * Narrative IR の AI タスク共通ガード。AI ポリシーとライセンスの両方を
 * 1 つの式で見る。
 *
 * ライセンス認証設計書 §6 の配置規約は「ゲートは store メソッド / UI 入口 /
 * 既存 `blockIfPolicyOff` の隣に置く」。narrative-extraction の AI タスク群は
 * その「隣」だけが実装されておらず、`blockIfPolicyOff("analysis")` は全 22
 * タスクにあるのに `blockIfUnlicensed()` は 1 つも無い状態だった。
 * つまり trial_expired / revoked / license_stale のまま伏線・年表・プロット
 * スレッド等の抽出を走らせると、実際に有償モデルを叩けてしまう。
 *
 * 2 つのガードを別々の式に置くのではなく 1 関数にまとめてあるのは、
 * 片方だけ書かれた新タスクが増える経路を塞ぐため。同ディレクトリの
 * `narrativeAiTaskGuard.test.ts` が「aiTasks/ 配下は policyGuard を直接
 * import しない」ことを検査しており、そこが規約の機械的な正本になる。
 *
 * 評価順は policy が先。ポリシー OFF は「機能を使わない」という利用者自身の
 * 設定で、ライセンス制限より説明として優先されるべきだから。
 */
export function blockNarrativeAiTask(feature: AiFeature = "analysis"): boolean {
  if (blockIfPolicyOff(feature)) return true;
  // toast id を渡すのは重複抑止のため。1 回のユーザー操作が複数タスクに
  // 展開される経路が実在し（例: 合成タスク → `runStructuredRepairTask`）、
  // 素の toast だと同じ文言がタスク数だけ積み上がる。
  return blockIfUnlicensed("narrative-ai-task-license-blocked");
}
