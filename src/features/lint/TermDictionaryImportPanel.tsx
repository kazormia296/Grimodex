import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

import { useTermDictionaryStore } from "./termDictionaryStore";
import type { CsvParseResult } from "./termDictionaryCsv";
import type { ImportMode } from "./termDictionaryImport";

export interface ImportPreview {
  fileName: string;
  parse: CsvParseResult;
}

/**
 * CSV インポートのプレビュー & 実行パネル。パース結果の件数・スキップ理由を
 * 見せ、マージ / 全置換を選ばせてから `bulkImport` を叩く。ファイル選択と
 * パースは呼び出し側（TermDictionaryTab）で済ませ、ここは確認 → 実行に専念。
 */
export function TermDictionaryImportPanel({
  preview,
  onClose,
}: {
  preview: ImportPreview;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const bulkImport = useTermDictionaryStore((s) => s.bulkImport);
  const [mode, setMode] = useState<ImportMode>("merge");
  const [running, setRunning] = useState(false);

  const { entries, errors, rowCount } = preview.parse;

  const run = async () => {
    if (running) return;
    if (
      mode === "replace" &&
      !window.confirm(
        t(
          "lint.termDict.confirmReplace",
          "既存の用語辞書をすべて削除して置き換えます。よろしいですか？",
        ),
      )
    ) {
      return;
    }
    setRunning(true);
    try {
      const result = await bulkImport(entries, mode);
      toast.success(
        t("lint.termDict.importDone", {
          added: result.added,
          updated: result.updated,
          skipped: result.skipped.length,
          defaultValue:
            "取込完了: 追加 {{added}} / 更新 {{updated}} / スキップ {{skipped}}",
        }),
      );
      onClose();
    } catch (err) {
      toast.error(
        t("lint.termDict.importFailed", "取込に失敗しました") +
          `: ${String(err)}`,
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="rounded border border-border bg-muted/20 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <h5 className="font-semibold">
          {t("lint.termDict.importPreviewTitle", "CSV インポート")}
        </h5>
        <span className="text-muted-foreground">{preview.fileName}</span>
      </div>

      <p className="mb-2">
        {t("lint.termDict.importSummary", {
          entries: entries.length,
          rows: rowCount,
          defaultValue: "{{rows}} 行から {{entries}} 件のエントリを検出",
        })}
      </p>

      {errors.length > 0 && (
        <div className="mb-2 rounded border border-yellow-300 bg-yellow-50 p-2 dark:border-yellow-900 dark:bg-yellow-950/30">
          <div className="mb-1 flex items-center gap-1 text-yellow-800 dark:text-yellow-400">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t("lint.termDict.importSkippedRows", {
              count: errors.length,
              defaultValue: "{{count}} 行をスキップしました",
            })}
          </div>
          <ul className="max-h-24 overflow-auto text-[11px] text-muted-foreground">
            {errors.map((e, i) => (
              <li key={i}>・{e}</li>
            ))}
          </ul>
        </div>
      )}

      <fieldset className="mb-3 flex flex-col gap-1">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="import-mode"
            checked={mode === "merge"}
            onChange={() => setMode("merge")}
          />
          <span>
            {t(
              "lint.termDict.importModeMerge",
              "マージ（推奨表記が一致する行は更新、他は追加、既存はそのまま）",
            )}
          </span>
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name="import-mode"
            checked={mode === "replace"}
            onChange={() => setMode("replace")}
          />
          <span className="text-red-600 dark:text-red-400">
            {t(
              "lint.termDict.importModeReplace",
              "全置換（既存の辞書をすべて削除して入れ替え）",
            )}
          </span>
        </label>
      </fieldset>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void run()}
          disabled={running || entries.length === 0}
          className="rounded border border-border bg-primary px-3 py-1 text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {running
            ? t("lint.termDict.importing", "取込中…")
            : t("lint.termDict.importRun", "取り込む")}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={running}
          className="rounded border border-border px-3 py-1 hover:bg-accent"
        >
          {t("common.cancel", "キャンセル")}
        </button>
      </div>
    </div>
  );
}
