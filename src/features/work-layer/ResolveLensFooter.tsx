import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { WorkLayerCandidateView, WorkLayerFindingView } from "./types";

interface ResolveLensFooterProps {
  readonly finding: WorkLayerFindingView;
  readonly selectedCandidate?: WorkLayerCandidateView;
  readonly nextFinding?: WorkLayerFindingView;
  readonly actionNote: string | null;
  readonly portalAvailable: boolean;
  readonly onBind: () => void;
  readonly onHold: () => void;
  readonly onExcludePair: () => void;
  readonly onNext: () => void;
  readonly onOpenPortal: () => void;
  readonly onInspect: () => void;
}

export function ResolveLensFooter({
  finding,
  selectedCandidate,
  nextFinding,
  actionNote,
  portalAvailable,
  onBind,
  onHold,
  onExcludePair,
  onNext,
  onOpenPortal,
  onInspect,
}: ResolveLensFooterProps) {
  const { t } = useTranslation();

  return (
    <footer className="border-t border-foreground/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {selectedCandidate != null && (
          <button
            type="button"
            aria-label={t(
              "workLayer.lens.bindingPreviewAria",
              "{{candidate}}へBindingをプレビュー",
              { candidate: selectedCandidate.label },
            )}
            onClick={onBind}
            className="rounded-sm bg-foreground px-3 py-2 text-xs font-medium text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("workLayer.lens.binding", "{{candidate}}へ Binding", {
              candidate: selectedCandidate.label,
            })}
          </button>
        )}
        <button
          type="button"
          onClick={onHold}
          className="rounded-sm border border-foreground/30 px-3 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("workLayer.lens.hold", "保留")}
        </button>
        {finding.candidates.length > 1 && (
          <button
            type="button"
            onClick={onExcludePair}
            className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("workLayer.lens.excludePair", "この2件を今後同一候補にしない")}
          </button>
        )}
        {portalAvailable && (
          <button
            id="work-layer-open-portal"
            type="button"
            aria-label={t("workLayer.portal.open", "Context Portalを開く")}
            onClick={onOpenPortal}
            className="rounded-sm border border-foreground/30 px-3 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            CONTEXT PORTAL
          </button>
        )}
        <button
          id="work-layer-inspect-lens"
          type="button"
          aria-label={t("workLayer.inspect.open", "詳細を検査")}
          onClick={onInspect}
          className="ml-auto flex items-center gap-1.5 rounded-sm border border-foreground/30 px-3 py-2 font-mono text-[9px] tracking-[0.1em] hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Search className="h-3 w-3" /> INSPECT
        </button>
      </div>
      <div className="mt-2 flex min-h-5 items-center gap-3">
        <span role="status" className="text-[10px] text-muted-foreground">
          {actionNote}
        </span>
        {nextFinding != null && (
          <button
            id="work-layer-next-finding"
            type="button"
            onClick={onNext}
            className="ml-auto font-mono text-[9px] tracking-[0.08em] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("workLayer.lens.next", "次: {{title}}", {
              title: nextFinding.title,
            })}
          </button>
        )}
      </div>
    </footer>
  );
}
