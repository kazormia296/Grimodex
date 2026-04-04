import { useState } from "react";
import { toast } from "sonner";
import { invoke } from "@/lib/tauri";
import { debugLog, errorDetail } from "@/lib/debugLog";
import {
  buildCrossReferenceReport,
  type CrossReferenceEntry,
} from "@/features/codex/crossReference";

interface IntegrityReport {
  orphanedCodexSources: number;
  orphanedSnippetSources: number;
  orphanedSnippetScenes: number;
}

interface RepairReport {
  codexSourcesFixed: number;
  snippetSourcesFixed: number;
  snippetScenesFixed: number;
}

export function IntegrityCheckDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [isChecking, setIsChecking] = useState(false);
  const [isRepairing, setIsRepairing] = useState(false);
  const [isBuildingXref, setIsBuildingXref] = useState(false);
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [crossRefs, setCrossRefs] = useState<CrossReferenceEntry[] | null>(
    null,
  );

  if (!open) return null;

  async function runCheck() {
    setIsChecking(true);
    try {
      const result = await invoke<IntegrityReport>("integrity_check");
      setReport(result);
    } catch (e) {
      toast.error("整合性チェックに失敗しました");
      debugLog.error("IntegrityCheck", "check failed", errorDetail(e));
    } finally {
      setIsChecking(false);
    }
  }

  async function runRepair() {
    setIsRepairing(true);
    try {
      const result = await invoke<RepairReport>("repair_integrity");
      toast.success(
        `修復完了: Codex ${result.codexSourcesFixed}件, スニペット参照元 ${result.snippetSourcesFixed}件, スニペットシーン ${result.snippetScenesFixed}件`,
      );
      // Re-run check to update display
      const updated = await invoke<IntegrityReport>("integrity_check");
      setReport(updated);
    } catch (e) {
      toast.error("修復に失敗しました");
      debugLog.error("IntegrityCheck", "repair failed", errorDetail(e));
    } finally {
      setIsRepairing(false);
    }
  }

  async function runCrossRefReport() {
    setIsBuildingXref(true);
    try {
      const result = await buildCrossReferenceReport();
      setCrossRefs(result);
    } catch (e) {
      toast.error("相互参照レポートの生成に失敗しました");
      debugLog.error(
        "IntegrityCheck",
        "cross-reference report failed",
        errorDetail(e),
      );
    } finally {
      setIsBuildingXref(false);
    }
  }

  const totalOrphans = report
    ? report.orphanedCodexSources +
      report.orphanedSnippetSources +
      report.orphanedSnippetScenes
    : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-background p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">整合性チェック</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 text-sm hover:bg-accent"
          >
            閉じる
          </button>
        </div>

        {/* Integrity Check Section */}
        <section className="mb-6">
          <h3 className="mb-2 text-sm font-semibold">孤立参照チェック</h3>
          <button
            type="button"
            onClick={runCheck}
            disabled={isChecking}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isChecking ? "チェック中..." : "チェック実行"}
          </button>

          {report && (
            <div className="mt-3 rounded border border-border p-3">
              <table className="w-full text-sm">
                <tbody>
                  <tr>
                    <td className="py-1 text-muted-foreground">
                      Codex: 削除済みメッセージへの参照
                    </td>
                    <td className="py-1 text-right font-mono">
                      {report.orphanedCodexSources}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1 text-muted-foreground">
                      スニペット: 削除済みメッセージへの参照
                    </td>
                    <td className="py-1 text-right font-mono">
                      {report.orphanedSnippetSources}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1 text-muted-foreground">
                      スニペット: 削除済みシーンへの参照
                    </td>
                    <td className="py-1 text-right font-mono">
                      {report.orphanedSnippetScenes}
                    </td>
                  </tr>
                </tbody>
              </table>

              {totalOrphans > 0 && (
                <button
                  type="button"
                  onClick={runRepair}
                  disabled={isRepairing}
                  className="mt-3 rounded bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                >
                  {isRepairing
                    ? "修復中..."
                    : `修復（${totalOrphans}件の孤立参照をクリア）`}
                </button>
              )}

              {totalOrphans === 0 && (
                <p className="mt-2 text-sm text-green-600">
                  問題は見つかりませんでした。
                </p>
              )}
            </div>
          )}
        </section>

        {/* Cross-reference Report Section */}
        <section>
          <h3 className="mb-2 text-sm font-semibold">
            Codex × シーン 相互参照レポート
          </h3>
          <button
            type="button"
            onClick={runCrossRefReport}
            disabled={isBuildingXref}
            className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isBuildingXref ? "生成中..." : "レポート生成"}
          </button>

          {crossRefs && (
            <div className="mt-3 max-h-64 overflow-y-auto rounded border border-border">
              {crossRefs.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">
                  Codexエントリがありません。
                </p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted">
                    <tr>
                      <th className="px-3 py-1.5 text-left font-medium">
                        エントリ
                      </th>
                      <th className="px-3 py-1.5 text-left font-medium">
                        タイプ
                      </th>
                      <th className="px-3 py-1.5 text-left font-medium">
                        言及シーン
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {crossRefs.map((ref) => (
                      <tr key={ref.entryId}>
                        <td className="px-3 py-1.5">{ref.entryName}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {ref.entryType}
                        </td>
                        <td className="px-3 py-1.5">
                          {ref.scenes.length === 0 ? (
                            <span className="text-muted-foreground">
                              未使用
                            </span>
                          ) : (
                            <span>
                              {ref.scenes
                                .map((s) => `${s.sceneTitle}(${s.count}回)`)
                                .join(", ")}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
