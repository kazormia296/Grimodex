import { useState } from "react";
import { useTranslation } from "react-i18next";

import { FindingCandidateList } from "./FindingCandidateList";
import type { WorkLayerFindingView } from "./types";
import { withNewPersonCandidate } from "./workLayerCandidateChoices";

interface ProjectionDecisionPanelProps {
  readonly finding: WorkLayerFindingView;
  readonly nextFinding?: WorkLayerFindingView;
  readonly selectedCandidateId: string | null;
  readonly onSelectCandidate: (candidateId: string) => void;
  readonly onResolve: (
    findingId: string,
    candidateId: string,
    decisionLabel: string,
  ) => void;
  readonly onNext: () => void;
}

export function ProjectionDecisionPanel({
  finding,
  nextFinding,
  selectedCandidateId,
  onSelectCandidate,
  onResolve,
  onNext,
}: ProjectionDecisionPanelProps) {
  const { t } = useTranslation();
  const candidates = withNewPersonCandidate(
    finding.candidates,
    t("workLayer.lens.createPerson", "新しい人物として作成"),
  );
  const [actionNote, setActionNote] = useState<string | null>(null);
  const selectedCandidate =
    candidates.find((candidate) => candidate.id === selectedCandidateId) ??
    candidates[0];

  if (candidates.length === 0) return null;

  return (
    <section className="mt-5 border-t border-border pt-4">
      <FindingCandidateList
        candidates={candidates}
        findingId={`projection-${finding.id}`}
        selectedCandidateId={selectedCandidate?.id ?? ""}
        onSelect={onSelectCandidate}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {selectedCandidate != null && (
          <button
            type="button"
            aria-label={t(
              "workLayer.lens.bindingPreviewAria",
              "{{candidate}}へBindingをプレビュー",
              { candidate: selectedCandidate.label },
            )}
            onClick={() =>
              onResolve(
                finding.id,
                selectedCandidate.id,
                t("workLayer.lens.bindingDecision", "{{candidate}}へ Binding", {
                  candidate: selectedCandidate.label,
                }),
              )
            }
            className="rounded-sm bg-foreground px-3 py-2 text-xs font-medium text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("workLayer.lens.binding", "{{candidate}}へ Binding", {
              candidate: selectedCandidate.label,
            })}
          </button>
        )}
        <button
          type="button"
          onClick={() =>
            setActionNote(
              t(
                "workLayer.lens.holdPreview",
                "保留をプレビューしました。保存されていません。",
              ),
            )
          }
          className="rounded-sm border border-foreground/30 px-3 py-2 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("workLayer.lens.hold", "保留")}
        </button>
        <button
          type="button"
          onClick={() =>
            setActionNote(
              t(
                "workLayer.lens.excludePairPreview",
                "候補ペアの除外をプレビューしました。保存されていません。",
              ),
            )
          }
          className="text-[10px] text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("workLayer.lens.excludePair", "この2件を今後同一候補にしない")}
        </button>
      </div>
      <div className="mt-2 flex min-h-5 items-center">
        <span role="status" className="text-[10px] text-muted-foreground">
          {actionNote}
        </span>
        {nextFinding != null && (
          <button
            type="button"
            onClick={onNext}
            className="ml-auto font-mono text-[9px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("workLayer.lens.next", "次: {{title}}", {
              title: nextFinding.title,
            })}
          </button>
        )}
      </div>
    </section>
  );
}
