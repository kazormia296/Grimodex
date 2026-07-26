import { useLintProjectStore } from "@/features/lint/lintProjectStore";
import { usePostEffectRunStore } from "@/features/post-effect/runStore";
import { CAT_EFFECTS } from "./catalog";
import type { IssueCat } from "./issueModel";

/**
 * 観点単位の「実行中」判定。effect 種別レベルで照合する（スコープ非依存）。
 *
 * useIsPostEffectRunning の scope 厳密一致とは意図的に違う: タイル/フッターは
 * 「この観点がいま動いているか」を表す観点レベルの UI で、スコープ違いの
 * 並走 run（例: 全体チェックの folder run と手動の scene run）も「動いている」
 * と見せるのが正しい。取り逃しによるスピナー消失・二重起動穴も起きない。
 * intent の per-scene 直列（scope=scene の連続 run）もこれで拾える。
 * linter は post-effect 外なので lintProjectStore.phase で判定する。
 */
export function useIsCatRunning(cat: IssueCat): boolean {
  const lintRunning = useLintProjectStore((s) => s.phase === "running");
  const effects = CAT_EFFECTS[cat] as readonly string[];
  const peRunning = usePostEffectRunStore((s) =>
    Object.values(s.runs).some(
      (r) => r.outcome === undefined && effects.includes(r.effectType),
    ),
  );
  return cat === "linter" ? lintRunning : peRunning;
}
