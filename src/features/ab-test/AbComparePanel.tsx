import { AbCompareColumn } from "./AbCompareColumn";
import type { AbConfig, AbRunResult } from "./abHarness";

interface AbComparePanelProps {
  configA: AbConfig;
  configB: AbConfig;
  /** A 列の結果。null = まだ結果なし。 */
  resultA: AbRunResult | null;
  /** B 列の結果。null = まだ結果なし。 */
  resultB: AbRunResult | null;
  /** 比較を実行中か。null 結果を「実行中」と「未生成」で描き分けるため。 */
  running?: boolean;
  /** 採用済みの列 ("a" | "b" | null)。 */
  chosen: "a" | "b" | null;
  /** A / B いずれかの採用ボタン押下。 */
  onAdopt: (side: "a" | "b") => void;
  /** 採用操作を許可するか。履歴閲覧 (read-only) では false。 */
  adoptable?: boolean;
}

/**
 * A/B 2 構成を横並び (flex) で見せる比較サーフェスのコア表示部。
 * inline/beat はインライン採用、chat は専用モーダルから利用する。
 * ライブ ChatPanel のストリーム描画とは完全に独立。
 */
export function AbComparePanel({
  configA,
  configB,
  resultA,
  resultB,
  running = false,
  chosen,
  onAdopt,
  adoptable = true,
}: AbComparePanelProps) {
  return (
    <div className="flex min-h-0 w-full gap-3">
      <AbCompareColumn
        side="a"
        modelLabel={configA.model}
        promptVariant={configA.promptVariant}
        result={resultA}
        running={running}
        chosen={chosen === "a"}
        onAdopt={() => onAdopt("a")}
        adoptable={adoptable}
      />
      <AbCompareColumn
        side="b"
        modelLabel={configB.model}
        promptVariant={configB.promptVariant}
        result={resultB}
        running={running}
        chosen={chosen === "b"}
        onAdopt={() => onAdopt("b")}
        adoptable={adoptable}
      />
    </div>
  );
}
