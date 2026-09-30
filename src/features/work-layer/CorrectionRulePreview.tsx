import { X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

interface CorrectionRulePreviewProps {
  readonly onClose: () => void;
}

export function CorrectionRulePreview({ onClose }: CorrectionRulePreviewProps) {
  const { t } = useTranslation();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section
      role="region"
      aria-label={t(
        "workLayer.review.correction.aria",
        "Correction ruleの作成プレビュー",
      )}
      className="mt-3 rounded-sm border border-foreground/30 bg-muted/30 p-3"
    >
      <div className="flex items-center gap-2">
        <h3 className="font-mono text-[9px] tracking-[0.12em]">
          {t(
            "workLayer.review.correction.heading",
            "CORRECTION RULE · UI PREVIEW",
          )}
        </h3>
        <span className="text-[9px] text-muted-foreground">
          {t("workLayer.review.previewOnly", "PREVIEW ONLY · NOT SAVED")}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={t(
            "workLayer.review.correction.close",
            "Correction ruleの作成プレビューを閉じる",
          )}
          className="ml-auto rounded-sm p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <label className="mt-3 block text-[10px] text-muted-foreground">
        {t("workLayer.review.correction.label", "Correction rule")}
        <textarea
          ref={textareaRef}
          aria-label={t("workLayer.review.correction.label", "Correction rule")}
          defaultValue={t(
            "workLayer.review.correction.defaultValue",
            "Evidenceが失われたChronicle Eventを再提案する",
          )}
          className="mt-1 min-h-16 w-full resize-y rounded-sm border border-foreground/30 bg-background px-2 py-1.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <p className="mt-2 text-[10px] text-muted-foreground">
        {t(
          "workLayer.review.correction.note",
          "ルールの編集内容はこのUIプレビュー内だけに保持され、保存されません。",
        )}
      </p>
    </section>
  );
}
