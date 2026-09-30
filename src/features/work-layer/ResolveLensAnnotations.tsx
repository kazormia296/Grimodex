import { useTranslation } from "react-i18next";

interface ResolveLensAnnotationsProps {
  readonly attentionCount: number;
  readonly anchorLabel: string | null;
  readonly candidateCount: number;
}

export function ResolveLensAnnotations({
  attentionCount,
  anchorLabel,
  candidateCount,
}: ResolveLensAnnotationsProps) {
  const { t } = useTranslation();

  return (
    <div
      aria-label={t("workLayer.lens.annotations", "Lens注釈投影")}
      className="pointer-events-none absolute inset-0 font-mono text-[8px] tracking-[0.12em]"
    >
      <span className="absolute left-3 top-14 rounded-sm border border-foreground/50 bg-background px-1.5 py-1">
        SCENE ATTN · {attentionCount}
      </span>
      <span className="absolute bottom-16 left-[43%] top-16 w-[3px] bg-foreground/30" />
      {anchorLabel != null && (
        <span
          data-testid="work-layer-editor-anchor"
          className="absolute left-[43%] top-[39%] border-b-2 border-foreground bg-background/90 px-0.5 font-serif text-sm font-semibold tracking-normal"
        >
          {anchorLabel}
        </span>
      )}
      <span
        data-testid="work-layer-lens-leader"
        className="absolute left-[43%] right-[30rem] top-[42%] border-t border-dashed border-foreground/45"
      />
      <span className="absolute right-[30.5rem] top-14 rounded-sm border border-dashed border-foreground/50 bg-background px-1.5 py-1">
        CODEX CAND · {candidateCount}
      </span>
    </div>
  );
}
