import { AbCompareColumn } from "./AbCompareColumn";
import type { AbRunResult } from "./abHarness";

/** 1 列分の表示データ (ダイアログ側で枠 + 結果から組み立てる)。 */
export interface AbCompareColumnView {
  id: string;
  label: string;
  providerLabel?: string | null;
  modelLabel?: string | null;
  promptVariant?: string | null;
  result: AbRunResult | null;
}

interface AbComparePanelProps {
  columns: AbCompareColumnView[];
  /** 比較を実行中か。null 結果を「実行中」と「未生成」で描き分けるため。 */
  running?: boolean;
  /** 採用済みの列 id。 */
  chosenId: string | null;
  /** いずれかの列の採用ボタン押下。 */
  onAdopt: (id: string) => void;
  /** 採用操作を許可するか。履歴閲覧 (read-only) では false。 */
  adoptable?: boolean;
}

/**
 * A/B の N 構成を横並び (flex) で見せる比較サーフェスのコア表示部。
 * 3 列以上は横スクロール (各列 min-width 固定)。inline/beat はインライン採用、
 * chat は専用モーダルから利用する。ライブ ChatPanel のストリーム描画とは完全に独立。
 */
export function AbComparePanel({
  columns,
  running = false,
  chosenId,
  onAdopt,
  adoptable = true,
}: AbComparePanelProps) {
  return (
    <div className="flex min-h-0 w-full gap-3 overflow-x-auto">
      {columns.map((col) => (
        <AbCompareColumn
          key={col.id}
          label={col.label}
          providerLabel={col.providerLabel}
          modelLabel={col.modelLabel}
          promptVariant={col.promptVariant}
          result={col.result}
          running={running}
          chosen={chosenId === col.id}
          onAdopt={() => onAdopt(col.id)}
          adoptable={adoptable}
        />
      ))}
    </div>
  );
}
