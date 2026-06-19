import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { DURATIONS, EASINGS } from "@/lib/animation";
import { formatCost } from "@/features/chat/modelPricing";
import {
  loadProvenanceAnalytics,
  UNKNOWN_MODEL,
  type KindBucket,
  type ProvenanceAnalyticsReport,
} from "./provenanceAnalytics";

const pct = (n: number, total: number) =>
  total > 0 ? Math.round((n / total) * 100) : 0;

/** "~$1.23" 表記（概算であることを明示する）。 */
function approxCost(usd: number, prefix: string): string {
  return `${prefix}${formatCost(usd)}`;
}

function ModelContributionTable({
  report,
}: {
  report: ProvenanceAnalyticsReport;
}) {
  const { t } = useTranslation();
  const aiTotal = report.modelContribution.reduce((n, r) => n + r.chars, 0);
  if (report.modelContribution.length === 0) return null;
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium text-foreground">
        {t("provenanceAnalytics.modelTitle")}
      </h4>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-2 py-1 text-left font-normal">
              {t("provenanceAnalytics.modelColModel")}
            </th>
            <th className="px-2 py-1 text-right font-normal">
              {t("provenanceAnalytics.modelColChars")}
            </th>
            <th className="px-2 py-1 text-right font-normal">
              {t("provenanceAnalytics.modelColPassages")}
            </th>
            <th className="px-2 py-1 text-right font-normal">
              {t("provenanceAnalytics.modelColPct")}
            </th>
          </tr>
        </thead>
        <tbody>
          {report.modelContribution.map((row) => (
            <tr key={row.model} className="hover:bg-accent/40">
              <td className="px-2 py-0.5 text-muted-foreground">
                <span className="block max-w-[200px] truncate">
                  {row.model === UNKNOWN_MODEL
                    ? t("provenanceAnalytics.unknownModel")
                    : row.model}
                </span>
              </td>
              <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                {row.chars.toLocaleString()}
              </td>
              <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                {row.passages}
              </td>
              <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                {pct(row.chars, aiTotal)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function KindDistributionTable({
  report,
}: {
  report: ProvenanceAnalyticsReport;
}) {
  const { t } = useTranslation();
  const d = report.kindDistribution;
  const rows: { label: string; bucket: KindBucket }[] = [
    { label: t("provenanceAnalytics.kindChat"), bucket: d.chat },
    { label: t("provenanceAnalytics.kindInlineAi"), bucket: d.inlineAi },
    { label: t("provenanceAnalytics.kindBeat"), bucket: d.beat },
    { label: t("provenanceAnalytics.kindOrphanChat"), bucket: d.orphanChat },
    { label: t("provenanceAnalytics.kindUnknownAi"), bucket: d.unknownAi },
  ];
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-medium text-foreground">
        {t("provenanceAnalytics.kindTitle")}
      </h4>
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="px-2 py-1 text-left font-normal">
              {t("provenanceAnalytics.kindColKind")}
            </th>
            <th className="px-2 py-1 text-right font-normal">
              {t("provenanceAnalytics.kindColChars")}
            </th>
            <th className="px-2 py-1 text-right font-normal">
              {t("provenanceAnalytics.kindColPassages")}
            </th>
            <th className="px-2 py-1 text-right font-normal">
              {t("provenanceAnalytics.kindColPct")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ label, bucket }) => (
            <tr key={label} className="hover:bg-accent/40">
              <td className="px-2 py-0.5 text-muted-foreground">{label}</td>
              <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                {bucket.chars.toLocaleString()}
              </td>
              <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                {bucket.passages}
              </td>
              <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                {pct(bucket.chars, d.totalChars)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CostTables({ report }: { report: ProvenanceAnalyticsReport }) {
  const { t } = useTranslation();
  if (!report.hasUsageData) return null;
  const prefix = t("provenanceAnalytics.approxPrefix");
  const c = report.costByKind;
  const kindRows = [
    { label: t("provenanceAnalytics.kindChat"), bucket: c.byKind.chat },
    { label: t("provenanceAnalytics.kindInlineAi"), bucket: c.byKind.inlineAi },
    { label: t("provenanceAnalytics.kindBeat"), bucket: c.byKind.beat },
  ];
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <h4 className="text-xs font-medium text-foreground">
          {t("provenanceAnalytics.costTitle")}
        </h4>
        <p className="text-[11px] leading-snug text-muted-foreground/80">
          {t("provenanceAnalytics.costApproxNote")}
        </p>
      </div>

      <div className="space-y-0.5">
        <h5 className="text-[11px] font-medium text-muted-foreground">
          {t("provenanceAnalytics.costByKindTitle")}
        </h5>
        <table className="w-full text-xs border-collapse">
          <tbody>
            {kindRows.map(({ label, bucket }) => (
              <tr key={label} className="hover:bg-accent/40">
                <td className="px-2 py-0.5 text-muted-foreground">{label}</td>
                <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                  {approxCost(bucket.costUsd, prefix)}
                </td>
              </tr>
            ))}
            {c.otherCostUsd > 0 && (
              <tr className="hover:bg-accent/40">
                <td className="px-2 py-0.5 text-muted-foreground">
                  {t("provenanceAnalytics.costKindOther")}
                </td>
                <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                  {approxCost(c.otherCostUsd, prefix)}
                </td>
              </tr>
            )}
            <tr className="border-t border-border font-medium">
              <td className="px-2 py-0.5 text-foreground">
                {t("provenanceAnalytics.costTotal")}
              </td>
              <td className="px-2 py-0.5 text-right tabular-nums text-foreground">
                {approxCost(c.totalCostUsd, prefix)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {report.costByModel.length > 0 && (
        <div className="space-y-0.5">
          <h5 className="text-[11px] font-medium text-muted-foreground">
            {t("provenanceAnalytics.costByModelTitle")}
          </h5>
          <table className="w-full text-xs border-collapse">
            <tbody>
              {report.costByModel.map((row) => (
                <tr key={row.model} className="hover:bg-accent/40">
                  <td className="px-2 py-0.5 text-muted-foreground">
                    <span className="block max-w-[200px] truncate">
                      {row.model === UNKNOWN_MODEL
                        ? t("provenanceAnalytics.unknownModel")
                        : row.model}
                    </span>
                  </td>
                  <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                    {row.calls}
                  </td>
                  <td className="px-2 py-0.5 text-right tabular-nums text-muted-foreground">
                    {approxCost(row.costUsd, prefix)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * 出所分析セクション（read-only）。AttributionProjectView の下部に差し込む。
 * 既存の `loadProvenanceAnalytics`（buildProvenanceBreakdown を流用、再構築なし）
 * から集計済みレポートを取り、モデル別寄与・種別分布・概算コストを表示する。
 *
 * `refreshKey` が変わると再読み込みする（親の更新ボタンと同期）。
 */
export function ProvenanceAnalyticsSection({
  projectId,
  refreshKey,
}: {
  projectId: string;
  refreshKey: number;
}) {
  const { t } = useTranslation();
  const [report, setReport] = useState<ProvenanceAnalyticsReport | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    setLoading(true);
    loadProvenanceAnalytics(projectId)
      .then((r) => {
        if (alive) setReport(r);
      })
      .catch(console.error)
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectId, refreshKey]);

  if (!report && !loading) return null;

  const hasAi = report != null && report.kindDistribution.totalChars > 0;

  return (
    <motion.section
      className="mt-4 space-y-3 border-t border-border pt-3"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATIONS.normal, ease: EASINGS.easeOut }}
    >
      <div className="space-y-0.5">
        <h3 className="text-xs font-semibold text-foreground">
          {t("provenanceAnalytics.sectionTitle")}
        </h3>
        <p className="text-[11px] leading-snug text-muted-foreground/80">
          {t("provenanceAnalytics.sectionHint")}
        </p>
      </div>

      {report && !hasAi ? (
        <p className="text-xs text-muted-foreground">
          {t("provenanceAnalytics.noAi")}
        </p>
      ) : (
        report && (
          <>
            <ModelContributionTable report={report} />
            <KindDistributionTable report={report} />
            <CostTables report={report} />
          </>
        )
      )}
    </motion.section>
  );
}
