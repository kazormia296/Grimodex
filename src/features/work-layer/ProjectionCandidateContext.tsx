import { useTranslation } from "react-i18next";

import type { WorkLayerCandidateView } from "./types";

export function ProjectionCandidateContext({
  candidate,
}: {
  readonly candidate: WorkLayerCandidateView;
}) {
  const { t } = useTranslation();

  return (
    <section
      role="region"
      aria-label={t(
        "workLayer.projection.candidateContext",
        "Context Portal · Codex",
      )}
      className="rounded-sm border border-dashed border-foreground/30 p-3"
    >
      <div className="flex items-center font-mono text-[8px] tracking-[0.12em] text-muted-foreground">
        CONTEXT PORTAL · CODEX
        <span className="ml-auto">
          {t("workLayer.projection.selectedCandidate", "選択中の候補")}
        </span>
      </div>
      <div className="mt-3 text-xs font-semibold">{candidate.label}</div>
      <div className="mt-1 text-[10px] text-muted-foreground">
        {candidate.meta}
      </div>
      <div className="mt-3 border-t border-border pt-2 font-mono text-[8px] tracking-[0.08em] text-muted-foreground">
        {t(
          "workLayer.projection.followsCandidate",
          "候補の選択に追従 · UI PREVIEW",
        )}
      </div>
    </section>
  );
}
