import { useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
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

export function IntegrityCheckSection() {
  const { t } = useTranslation();
  const [isChecking, setIsChecking] = useState(false);
  const [isRepairing, setIsRepairing] = useState(false);
  const [isBuildingXref, setIsBuildingXref] = useState(false);
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [crossRefs, setCrossRefs] = useState<CrossReferenceEntry[] | null>(
    null,
  );

  async function runCheck() {
    setIsChecking(true);
    try {
      const result = await invoke<IntegrityReport>("integrity_check");
      setReport(result);
    } catch (e) {
      toast.error(t("integrity.checkError"));
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
        t("integrity.repairSuccess", {
          codex: result.codexSourcesFixed,
          snippetSrc: result.snippetSourcesFixed,
          snippetScene: result.snippetScenesFixed,
        }),
      );
      // Re-run check to update display
      const updated = await invoke<IntegrityReport>("integrity_check");
      setReport(updated);
    } catch (e) {
      toast.error(t("integrity.repairError"));
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
      toast.error(t("integrity.crossRefError"));
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
    <>
      {/* Integrity Check Section */}
      <section className="mb-6">
        <h3 className="mb-2 text-sm font-semibold">
          {t("integrity.orphanCheck")}
        </h3>
        <button
          type="button"
          onClick={runCheck}
          disabled={isChecking}
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isChecking ? t("integrity.checking") : t("integrity.runCheck")}
        </button>

        {report && (
          <div className="mt-3 rounded border border-border p-3">
            <table className="w-full text-sm">
              <tbody>
                <tr>
                  <td className="py-1 text-muted-foreground">
                    {t("integrity.codexOrphans")}
                  </td>
                  <td className="py-1 text-right font-mono">
                    {report.orphanedCodexSources}
                  </td>
                </tr>
                <tr>
                  <td className="py-1 text-muted-foreground">
                    {t("integrity.snippetSourceOrphans")}
                  </td>
                  <td className="py-1 text-right font-mono">
                    {report.orphanedSnippetSources}
                  </td>
                </tr>
                <tr>
                  <td className="py-1 text-muted-foreground">
                    {t("integrity.snippetSceneOrphans")}
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
                  ? t("integrity.repairing")
                  : t("integrity.repairCount", { count: totalOrphans })}
              </button>
            )}

            {totalOrphans === 0 && (
              <p className="mt-2 text-sm text-green-600">
                {t("integrity.noIssues")}
              </p>
            )}
          </div>
        )}
      </section>

      {/* Cross-reference Report Section */}
      <section>
        <h3 className="mb-2 text-sm font-semibold">
          {t("integrity.crossRefSection")}
        </h3>
        <button
          type="button"
          onClick={runCrossRefReport}
          disabled={isBuildingXref}
          className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isBuildingXref
            ? t("integrity.crossRefBuilding")
            : t("integrity.generateReport")}
        </button>

        {crossRefs && (
          <div className="mt-3 max-h-64 overflow-y-auto rounded border border-border">
            {crossRefs.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">
                {t("integrity.noEntries")}
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">
                      {t("integrity.entry")}
                    </th>
                    <th className="px-3 py-1.5 text-left font-medium">
                      {t("integrity.type")}
                    </th>
                    <th className="px-3 py-1.5 text-left font-medium">
                      {t("integrity.mentionedScenes")}
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
                            {t("integrity.unused")}
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
    </>
  );
}
