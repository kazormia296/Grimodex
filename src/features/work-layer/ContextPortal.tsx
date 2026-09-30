import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import { useWorkLayer } from "./WorkLayerContext";
import { withNewPersonCandidate } from "./workLayerCandidateChoices";

interface ContextPortalProps {
  readonly selectedCandidateId: string | null;
  readonly onSelectCandidate: (candidateId: string) => void;
}

export function ContextPortal({
  selectedCandidateId,
  onSelectCandidate,
}: ContextPortalProps) {
  const workLayer = useWorkLayer();
  const { t } = useTranslation();
  const selectedCandidateRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    queueMicrotask(() =>
      selectedCandidateRef.current?.focus({ preventScroll: true }),
    );
  }, []);

  if (workLayer == null) return null;

  const { model, navigation, back, resolvePreview } = workLayer;
  const finding =
    model.attention.find(
      (candidate) => candidate.id === navigation.selectedFindingId,
    ) ?? model.attention[0];
  const candidates = withNewPersonCandidate(
    finding?.candidates ?? [],
    t("workLayer.lens.createPerson", "新しい人物として作成"),
  );
  const selectedCandidate =
    candidates.find((candidate) => candidate.id === selectedCandidateId) ??
    candidates[0];

  return (
    <section
      role="dialog"
      aria-label={t("workLayer.portal.aria", "Context Portal")}
      aria-modal="false"
      className="mt-4 rounded-sm border border-dashed border-foreground/50 bg-foreground/[0.03] p-3 text-foreground"
    >
      <header className="flex items-center">
        <span className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
          CONTEXT PORTAL · CODEX BINDING
        </span>
        <span className="ml-2 font-mono text-[8px] text-muted-foreground">
          {t("workLayer.portal.temporary", "一時的な召喚")}
        </span>
        <button
          type="button"
          onClick={back}
          aria-label={t("workLayer.portal.dismiss", "Context Portalを閉じる")}
          className="ml-auto rounded-sm p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>

      <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
        {t(
          "workLayer.portal.note",
          "不在のCodex文脈を一時的に表示しています。この選択はまだ保存されません。",
        )}
      </p>

      <div
        className="mt-3 space-y-1"
        role="radiogroup"
        aria-label={t("workLayer.portal.candidates", "Binding候補")}
      >
        {candidates.map((candidate) => (
          <label
            key={candidate.id}
            className="flex cursor-pointer items-center gap-2 rounded-sm border border-border px-3 py-2 text-xs hover:bg-accent"
          >
            <input
              ref={
                selectedCandidate?.id === candidate.id
                  ? selectedCandidateRef
                  : undefined
              }
              type="radio"
              name="context-portal-candidate"
              value={candidate.id}
              checked={selectedCandidate?.id === candidate.id}
              onChange={() => onSelectCandidate(candidate.id)}
              aria-label={candidate.label}
            />
            <span className="font-medium">{candidate.label}</span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {candidate.meta}
            </span>
          </label>
        ))}
        {candidates.length === 0 && (
          <p className="rounded-sm border border-border p-3 text-xs text-muted-foreground">
            {t("workLayer.portal.empty", "Binding候補はありません。")}
          </p>
        )}
      </div>

      <footer className="mt-3 flex items-center border-t border-border pt-3">
        <span className="text-[10px] text-muted-foreground">
          {t("workLayer.portal.notSaved", "NOT SAVED")}
        </span>
        <button
          type="button"
          disabled={finding == null || selectedCandidate == null}
          aria-label={
            selectedCandidate == null
              ? t("workLayer.portal.preview", "Bindingをプレビュー")
              : t(
                  "workLayer.lens.bindingPreviewAria",
                  "{{candidate}}へBindingをプレビュー",
                  { candidate: selectedCandidate.label },
                )
          }
          onClick={() => {
            if (finding == null || selectedCandidate == null) return;
            resolvePreview(
              finding.id,
              selectedCandidate.id,
              t("workLayer.lens.bindingDecision", "{{candidate}}へ Binding", {
                candidate: selectedCandidate.label,
              }),
            );
          }}
          className="ml-auto rounded-sm bg-foreground px-3 py-2 text-xs font-medium text-background disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("workLayer.portal.preview", "Bindingをプレビュー")}
        </button>
      </footer>
    </section>
  );
}
