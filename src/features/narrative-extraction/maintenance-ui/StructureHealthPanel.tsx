import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getLoadedProjectId } from "@/application/project/currentProjectAuthority";
import { narrativeMaintenanceInboxList } from "@/application/narrative-extraction/nativeApi";
import {
  STALE_BREAKDOWN_KEYS,
  summarizeInbox,
  type StaleBreakdownKey,
  type StructureHealthSummary,
} from "./structureHealthModel";

interface Props {
  readonly onClose: () => void;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "no-project" }
  | { readonly kind: "failed" }
  | { readonly kind: "ready"; readonly summary: StructureHealthSummary };

const STALE_LABEL_DEFAULTS: Readonly<Record<StaleBreakdownKey, string>> = {
  stale: "根拠の本文が変わった",
  "source-missing": "根拠の場面が見つからない",
  "anchor-mismatch": "根拠の位置が合わない",
  "read-set-drift": "読んだ範囲が変わった",
  unknown: "判定できない",
};

const STALE_LABEL_KEYS: Readonly<Record<StaleBreakdownKey, string>> = {
  stale: "narrativeMaintenance.inbox.staleBreakdown.stale",
  "source-missing": "narrativeMaintenance.inbox.staleBreakdown.sourceMissing",
  "anchor-mismatch": "narrativeMaintenance.inbox.staleBreakdown.anchorMismatch",
  "read-set-drift": "narrativeMaintenance.inbox.staleBreakdown.readSetDrift",
  unknown: "narrativeMaintenance.inbox.staleBreakdown.unknown",
};

export function StructureHealthPanel({ onClose }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  // One read when the panel opens (the panel mounts only while open). No
  // polling, no subscription; closing and reopening reads again. A response
  // that arrives after unmount is dropped.
  useEffect(() => {
    let cancelled = false;
    const projectId = getLoadedProjectId();
    if (projectId === null) {
      setState({ kind: "no-project" });
      return () => {
        cancelled = true;
      };
    }
    void narrativeMaintenanceInboxList({ projectId })
      .then((entries) => {
        if (!cancelled) {
          setState({ kind: "ready", summary: summarizeInbox(entries) });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const count = (value: number) =>
    t("narrativeMaintenance.inbox.countUnit", "{{value}}件", { value });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="structure-health-title"
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border border-border bg-background p-4 shadow-lg">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 id="structure-health-title" className="text-base font-semibold">
              {t("narrativeMaintenance.title", "構造の健全性")}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t(
                "narrativeMaintenance.previewNote",
                "プレビュー: 保守が見ている項目を、開いたときに1回だけ数えます。自動では何も直さず、AI も使いません。",
              )}
            </p>
          </div>
          <button
            type="button"
            className="rounded border border-border px-2 py-1 text-xs"
            onClick={onClose}
          >
            {t("common.close", "閉じる")}
          </button>
        </div>

        <div
          className="rounded border border-border/60 px-3 py-2 text-sm"
          data-testid="structure-health-body"
          aria-busy={state.kind === "loading"}
        >
          {state.kind === "failed" && (
            <p
              className="text-muted-foreground"
              data-testid="structure-health-failed"
              role="alert"
            >
              {t(
                "narrativeMaintenance.inbox.failed",
                "件数を読み込めませんでした。閉じてもう一度開くと、読み直します。",
              )}
            </p>
          )}
          <div aria-live="polite" data-testid="structure-health-live">
            {state.kind === "loading" && (
              <p
                className="text-muted-foreground"
                data-testid="structure-health-loading"
              >
                {t("narrativeMaintenance.inbox.loading", "数えています…")}
              </p>
            )}
            {state.kind === "no-project" && (
              <p
                className="text-muted-foreground"
                data-testid="structure-health-no-project"
              >
                {t(
                  "narrativeMaintenance.inbox.noProject",
                  "作品が読み込まれていないため、数えられません。",
                )}
              </p>
            )}
            {state.kind === "ready" && state.summary.nothingToInspect && (
              <p
                className="text-muted-foreground"
                data-testid="structure-health-empty"
              >
                {t(
                  "narrativeMaintenance.inbox.empty",
                  "点検の対象がまだありません。",
                )}
              </p>
            )}
            {state.kind === "ready" && !state.summary.nothingToInspect && (
              <dl className="space-y-1" data-testid="structure-health-counts">
                <div className="flex justify-between gap-3">
                  <dt>
                    {t(
                      "narrativeMaintenance.inbox.proposalsChecked",
                      "点検した提案",
                    )}
                  </dt>
                  <dd data-testid="structure-health-checked">
                    {count(state.summary.proposalsChecked)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt>
                    {t(
                      "narrativeMaintenance.inbox.proposalsStale",
                      "根拠が古くなった提案",
                    )}
                  </dt>
                  <dd data-testid="structure-health-stale">
                    {count(state.summary.proposalsStale)}
                  </dd>
                </div>
                {STALE_BREAKDOWN_KEYS.filter(
                  (key) => state.summary.staleBreakdown[key] > 0,
                ).map((key) => (
                  <div
                    key={key}
                    className="flex justify-between gap-3 pl-4 text-xs text-muted-foreground"
                  >
                    <dt>
                      {t(STALE_LABEL_KEYS[key], STALE_LABEL_DEFAULTS[key])}
                    </dt>
                    <dd data-testid={`structure-health-stale-${key}`}>
                      {count(state.summary.staleBreakdown[key])}
                    </dd>
                  </div>
                ))}
                <div className="flex justify-between gap-3">
                  <dt>
                    {t(
                      "narrativeMaintenance.inbox.maintenanceStopped",
                      "保守が止まった記録",
                    )}
                  </dt>
                  <dd data-testid="structure-health-stopped">
                    {count(state.summary.maintenanceStopped)}
                  </dd>
                </div>
                {state.summary.unrecognized > 0 && (
                  <div className="flex justify-between gap-3">
                    <dt>
                      {t(
                        "narrativeMaintenance.inbox.unrecognized",
                        "読み取れなかった項目",
                      )}
                    </dt>
                    <dd data-testid="structure-health-unrecognized">
                      {count(state.summary.unrecognized)}
                    </dd>
                  </div>
                )}
              </dl>
            )}
          </div>
        </div>

        <p
          className="mt-3 text-xs text-muted-foreground"
          data-testid="structure-health-partial-note"
        >
          {t(
            "narrativeMaintenance.inbox.partialNote",
            "今は一部の点検だけを数えています（根拠が古くなった提案と、保守が止まった記録）。この件数に含まれない問題がある可能性があります。",
          )}
        </p>

        <div className="mt-4 rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
          {t(
            "narrativeMaintenance.principles",
            "この画面は読むだけです。数えるだけで、変更・再解析・書き換えは行いません。",
          )}
        </div>
      </div>
    </div>
  );
}
