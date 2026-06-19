import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { AlertTriangle, TrendingUp } from "lucide-react";
import {
  DURATIONS,
  EASINGS,
  useReducedMotion,
  VARIANTS,
} from "@/lib/animation";
import { SettingSection } from "@/features/settings/components/SettingSection";
import { SettingRow } from "@/features/settings/components/SettingRow";
import { SettingNumberInput } from "@/features/settings/components/SettingNumberInput";
import { useSettingNumber } from "@/features/settings/useSettingControl";
import { formatCost } from "@/features/chat/modelPricing";
import { getProjectUsageInRange, type ProjectUsageRange } from "./usageQuery";
import {
  computeBudgetEta,
  monthRange,
  type BudgetEtaResult,
} from "./budgetEta";

/** 予算が「接近」とみなす消化率しきい値 (%)。これ以上で黄色警告。 */
const APPROACHING_PCT = 80;

interface BudgetEtaSectionProps {
  projectId: string;
}

function fmtUsd(usd: number): string {
  if (usd <= 0) return "—";
  return formatCost(usd);
}

/**
 * 月予算とバーンレート / ETA を「表示専用」で出す節 (機能①)。
 *
 * 生成はブロックしない。予算を超過 / 接近している場合も非ブロッキングの警告
 * 表示にとどめる (recordAiUsage には一切手を入れない)。予算入力は project setting
 * (`ai.costBudgetPerMonth`) の往復で、0 = 未設定。
 */
export function BudgetEtaSection({ projectId }: BudgetEtaSectionProps) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const [range, setRange] = useState<ProjectUsageRange | null>(null);
  // 予算は store 経由 (SettingNumberInput と同じ層) で読み、入力即時に再計算する。
  const { value: budgetUsd } = useSettingNumber("ai.costBudgetPerMonth", 0);

  // 当月のコスト点だけを取得 (idx_ai_usage_project_created を活かす)。
  useEffect(() => {
    let alive = true;
    if (!projectId) {
      setRange({ points: [], totalCostUsd: 0, anyCostEstimated: false });
      return;
    }
    const { startMs, endMs } = monthRange(new Date());
    getProjectUsageInRange(
      projectId,
      new Date(startMs).toISOString(),
      new Date(endMs).toISOString(),
    )
      .then((r) => {
        if (alive) setRange(r);
      })
      .catch(() => {
        if (alive) setRange(null);
      });
    return () => {
      alive = false;
    };
  }, [projectId]);

  const eta: BudgetEtaResult | null = useMemo(() => {
    if (!range) return null;
    return computeBudgetEta({
      points: range.points,
      budgetUsd,
      now: new Date(),
    });
  }, [range, budgetUsd]);

  const estimated = range?.anyCostEstimated ?? false;
  const pct = eta?.percentConsumed ?? null;
  const warnLevel: "over" | "approaching" | "none" = !eta?.budgetSet
    ? "none"
    : eta.overBudget
      ? "over"
      : (pct ?? 0) >= APPROACHING_PCT || eta.projectedOverBudget
        ? "approaching"
        : "none";

  return (
    <SettingSection title={t("tokenBudget.title")}>
      <p className="mb-2 text-xs text-muted-foreground">
        {t("tokenBudget.intro")}
      </p>

      <SettingRow
        label={t("tokenBudget.monthlyBudget")}
        description={t("tokenBudget.monthlyBudgetDesc")}
      >
        <SettingNumberInput
          settingKey="ai.costBudgetPerMonth"
          min={0}
          step={1}
          defaultValue={0}
          unit="USD"
          placeholder={t("tokenBudget.unset")}
        />
      </SettingRow>

      {eta && (
        <>
          {eta.budgetSet && pct != null && (
            <div className="px-1 py-1.5">
              <div className="mb-1 flex items-baseline justify-between text-xs">
                <span className="text-muted-foreground">
                  {t("tokenBudget.consumed")}
                </span>
                <span
                  className={`tabular-nums ${
                    warnLevel === "over"
                      ? "font-semibold text-destructive"
                      : warnLevel === "approaching"
                        ? "font-medium text-amber-600 dark:text-amber-400"
                        : "text-foreground"
                  }`}
                >
                  {Math.round(pct)}%
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full transition-all ${
                    warnLevel === "over"
                      ? "bg-destructive"
                      : warnLevel === "approaching"
                        ? "bg-amber-500"
                        : "bg-primary/70"
                  }`}
                  style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                />
              </div>
            </div>
          )}

          <SettingRow label={t("tokenBudget.monthCost")}>
            <span className="text-sm tabular-nums text-foreground">
              {estimated && eta.monthCostUsd > 0 ? "≈" : ""}
              {fmtUsd(eta.monthCostUsd)}
            </span>
          </SettingRow>
          <SettingRow
            label={t("tokenBudget.dailyRate")}
            description={t("tokenBudget.dailyRateDesc", {
              days: eta.elapsedDays.toLocaleString(),
            })}
          >
            <span className="text-sm tabular-nums text-foreground">
              {fmtUsd(eta.dailyRateUsd)}
            </span>
          </SettingRow>
          <SettingRow
            label={t("tokenBudget.projectedMonthEnd")}
            description={t("tokenBudget.projectedMonthEndDesc")}
          >
            <span className="text-sm tabular-nums text-foreground">
              {fmtUsd(eta.projectedMonthEndUsd)}
            </span>
          </SettingRow>
          <SettingRow
            label={t("tokenBudget.recentProjected")}
            description={t("tokenBudget.recentProjectedDesc")}
          >
            <span className="text-sm tabular-nums text-foreground">
              {fmtUsd(eta.recentProjectedMonthEndUsd)}
            </span>
          </SettingRow>
          {eta.budgetSet && (
            <SettingRow
              label={t("tokenBudget.daysUntilBudget")}
              description={t("tokenBudget.daysUntilBudgetDesc")}
            >
              <span className="text-sm tabular-nums text-foreground">
                {eta.daysUntilBudget == null
                  ? "—"
                  : t("tokenBudget.daysValue", {
                      days: Math.round(eta.daysUntilBudget).toLocaleString(),
                    })}
              </span>
            </SettingRow>
          )}

          {warnLevel !== "none" && (
            <motion.div
              role="status"
              className={`mt-2 flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${
                warnLevel === "over"
                  ? "border-destructive/40 bg-destructive/10 text-destructive"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300"
              }`}
              initial={reduced ? false : VARIANTS.slideUp.initial}
              animate={VARIANTS.slideUp.animate}
              transition={
                reduced
                  ? { duration: 0 }
                  : { duration: DURATIONS.normal, ease: EASINGS.easeOut }
              }
            >
              {warnLevel === "over" ? (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              ) : (
                <TrendingUp className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              )}
              <span>
                {warnLevel === "over"
                  ? t("tokenBudget.warnOver")
                  : t("tokenBudget.warnApproaching")}{" "}
                <span className="opacity-80">
                  {t("tokenBudget.warnNonBlocking")}
                </span>
              </span>
            </motion.div>
          )}
        </>
      )}
    </SettingSection>
  );
}
