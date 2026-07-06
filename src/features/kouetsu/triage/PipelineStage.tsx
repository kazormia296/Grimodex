import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ChevronRight, CircleAlert, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  FULL_CHECK_STEP_LABEL_KEY,
  FULL_CHECK_STEP_ORDER,
  useFullCheckStore,
  type FullCheckStepId,
} from "../fullCheck";
import { useKouetsuStore } from "../kouetsuStore";
import { useResolvedKouetsuScope } from "../useResolvedKouetsuScope";
import { STEP_TO_CAT, SEV_CHIP_CLASS, SEV_DOT_CLASS } from "./catalog";
import type { UnifiedIssue } from "./issueModel";

/**
 * 全体チェックのパイプラインステージ（デザイン 1d / 2a）。実行中〜「閉じる」まで
 * 表示され、観点ごとの進行（済/実行中/待機/対象外/失敗）と件数バッジ、
 * 完了観点のアコーディオン（現在開いている指摘の行）を出す。
 * 行クリックでトリアージカードへ、実行中は「戻る」でリストに退避できる
 * （ヘッダの「実行中 n/N」ピルから復帰）。
 */
export function PipelineStage({ open }: { open: UnifiedIssue[] }) {
  const { t } = useTranslation();
  const scope = useResolvedKouetsuScope();
  const runState = useFullCheckStore((s) => s.runState);
  const steps = useFullCheckStore((s) => s.steps);
  const done = useFullCheckStore((s) => s.done);
  const total = useFullCheckStore((s) => s.total);
  const cancelRequested = useFullCheckStore((s) => s.cancelRequested);
  const requestCancel = useFullCheckStore((s) => s.requestCancel);
  const closePipeline = useFullCheckStore((s) => s.closePipeline);
  const hidePipeline = useFullCheckStore((s) => s.hidePipeline);
  const findingsTotal = useFullCheckStore((s) => s.findingsTotal);
  const setSelectedIssueId = useKouetsuStore((s) => s.setSelectedIssueId);

  const running = runState === "running";
  const cancelled = runState === "done" && cancelRequested;

  const byCat = useMemo(() => {
    const map = new Map<string, UnifiedIssue[]>();
    for (const issue of open) {
      const list = map.get(issue.cat);
      if (list) list.push(issue);
      else map.set(issue.cat, [issue]);
    }
    return map;
  }, [open]);

  // 直近に「done + 指摘あり」へ遷移したステップを自動で開く（デザイン 2a）。
  const [openStep, setOpenStep] = useState<FullCheckStepId | null>(null);
  const prevSteps = useRef(steps);
  useEffect(() => {
    for (const id of FULL_CHECK_STEP_ORDER) {
      const prev = prevSteps.current[id];
      const next = steps[id];
      if (next?.state === "done" && prev?.state !== "done" && next.count > 0) {
        setOpenStep(id);
      }
    }
    prevSteps.current = steps;
  }, [steps]);

  const scopeShort = t(`kouetsu.progressToast.scope.${scope.type}`);
  const pct =
    runState === "done"
      ? 100
      : total > 0
        ? Math.round((done / total) * 100)
        : 0;

  return (
    <div className="shrink-0 border-b border-border bg-muted/20">
      <div className="flex items-center gap-2 px-3 pt-2">
        {running ? (
          <>
            <Loader2
              size={14}
              className="animate-spin text-[var(--kouetsu-accent)]"
            />
            <span className="text-xs font-bold">
              {t("kouetsu.triage.pipeline.running", { scope: scopeShort })}
            </span>
            <span className="text-[10px] font-semibold text-[var(--kouetsu-accent)] tabular-nums">
              {t("kouetsu.fullCheck.progress", { done, total })}
            </span>
          </>
        ) : cancelled ? (
          <>
            <CircleAlert size={14} className="text-muted-foreground" />
            <span className="text-xs font-bold">
              {t("kouetsu.triage.pipeline.cancelled", { done, total })}
            </span>
          </>
        ) : (
          <>
            <CheckCircle2 size={14} className="text-[var(--kouetsu-ok)]" />
            <span className="text-xs font-bold">
              {t("kouetsu.triage.pipeline.done", { count: findingsTotal })}
            </span>
          </>
        )}
        <span className="ml-auto flex items-center gap-1">
          {running && (
            <button
              type="button"
              disabled={cancelRequested}
              onClick={() => requestCancel()}
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {cancelRequested
                ? t("kouetsu.progressToast.aborting")
                : t("kouetsu.fullCheck.cancel")}
            </button>
          )}
          <button
            type="button"
            onClick={() => (running ? hidePipeline() : closePipeline())}
            className="rounded border border-border bg-background px-2 py-0.5 text-[10px] font-semibold text-foreground hover:bg-accent"
          >
            {running
              ? t("kouetsu.triage.pipeline.back")
              : t("kouetsu.progressToast.close")}
          </button>
        </span>
      </div>
      <div className="mx-3 mt-2 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-[var(--kouetsu-accent)]"
          style={{ width: `${pct}%`, transition: "width 0.5s ease" }}
        />
      </div>
      <div className="max-h-72 overflow-y-auto px-1.5 py-1.5">
        {FULL_CHECK_STEP_ORDER.map((id) => (
          <StepRow
            key={id}
            id={id}
            issues={byCat.get(STEP_TO_CAT[id]) ?? []}
            open={openStep === id}
            onToggle={() => setOpenStep(openStep === id ? null : id)}
            onSelect={(issueId) => setSelectedIssueId(issueId)}
          />
        ))}
        {/* 影響レビューは全体チェック対象外（Codex 変更時に手動）を常設表示。 */}
        <div className="flex items-center gap-2 px-2 py-1 text-muted-foreground/60">
          <span className="h-3 w-3 shrink-0 rounded-full bg-muted" />
          <span className="text-[11px] font-medium">
            {t("kouetsu.impactReview.title")}
          </span>
          <span className="ml-auto text-[10px]">
            {t("kouetsu.triage.pipeline.impactManual")}
          </span>
        </div>
      </div>
    </div>
  );
}

function StepRow({
  id,
  issues,
  open,
  onToggle,
  onSelect,
}: {
  id: FullCheckStepId;
  issues: UnifiedIssue[];
  open: boolean;
  onToggle: () => void;
  onSelect: (issueId: string) => void;
}) {
  const { t } = useTranslation();
  const step = useFullCheckStore((s) => s.steps[id]);
  const name = t(FULL_CHECK_STEP_LABEL_KEY[id]);

  if (step.state === "skipped") {
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-muted-foreground/60">
        <span className="h-3 w-3 shrink-0 rounded-full bg-muted" />
        <span className="text-[11px] font-medium">{name}</span>
        <span className="ml-auto text-[10px]">
          {step.reason === "sceneLint"
            ? t("kouetsu.triage.pipeline.sceneLint")
            : t("kouetsu.triage.pipeline.excluded")}
        </span>
      </div>
    );
  }

  const doneWithFindings = step.state === "done" && step.count > 0;
  const worst = issues[0]?.sev ?? null;

  return (
    <div>
      <div
        role={doneWithFindings ? "button" : undefined}
        tabIndex={doneWithFindings ? 0 : undefined}
        onClick={doneWithFindings ? onToggle : undefined}
        onKeyDown={
          doneWithFindings
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onToggle();
                }
              }
            : undefined
        }
        className={cn(
          "flex items-center gap-2 rounded px-2 py-1",
          step.state === "running" && "bg-[var(--kouetsu-accent-weak)]/60",
          doneWithFindings && "cursor-pointer hover:bg-accent/40",
        )}
      >
        {step.state === "done" ? (
          <CheckCircle2
            size={13}
            className="shrink-0 text-[var(--kouetsu-ok)]"
          />
        ) : step.state === "running" ? (
          <Loader2
            size={13}
            className="shrink-0 animate-spin text-[var(--kouetsu-accent)]"
          />
        ) : step.state === "error" ? (
          <CircleAlert size={13} className="shrink-0 text-destructive" />
        ) : (
          <span className="h-3 w-3 shrink-0 rounded-full border-[1.5px] border-dashed border-muted-foreground/40" />
        )}
        <span
          className={cn(
            "text-[11px] font-semibold",
            step.state === "pending" && "text-muted-foreground",
          )}
        >
          {name}
        </span>
        {step.state === "done" && (
          <span
            className={cn(
              "ml-auto rounded-full px-1.5 py-px text-[9px] font-bold leading-tight",
              step.count > 0 && worst
                ? SEV_CHIP_CLASS[worst]
                : "bg-[var(--kouetsu-ok)]/15 text-[var(--kouetsu-ok)]",
            )}
          >
            {t("kouetsu.triage.pipeline.count", { count: step.count })}
          </span>
        )}
        {step.state === "error" && (
          <span
            className="ml-auto max-w-[50%] truncate text-[10px] text-destructive"
            title={step.error}
          >
            {step.error}
          </span>
        )}
        {step.state === "pending" && (
          <span className="ml-auto text-[10px] text-muted-foreground">
            {t("kouetsu.triage.pipeline.waiting")}
          </span>
        )}
        {doneWithFindings && (
          <ChevronRight
            size={11}
            className={cn(
              "shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </div>
      {open && doneWithFindings && (
        <div className="pb-1 pl-7 pr-2">
          {issues.length === 0 ? (
            <div className="px-1 py-0.5 text-[10px] text-muted-foreground">
              {t("kouetsu.triage.pipeline.noFindings")}
            </div>
          ) : (
            issues.map((issue) => (
              <button
                key={issue.id}
                type="button"
                onClick={() => onSelect(issue.id)}
                className="flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left hover:bg-accent/50"
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    SEV_DOT_CLASS[issue.sev],
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">
                  {issue.title}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
