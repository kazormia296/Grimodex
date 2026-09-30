import { useTranslation } from "react-i18next";

import type { WorkLayerFindingView } from "./types";

interface ResolveLensDetailsProps {
  readonly finding: WorkLayerFindingView;
}

function renderAnchoredExcerpt(finding: WorkLayerFindingView) {
  const excerpt = finding.source.excerpt;
  if (excerpt == null) return null;
  const anchor = finding.title.match(/[『「](.+?)[』」]/)?.[1];
  if (anchor == null || !excerpt.includes(anchor)) return excerpt;
  const anchorIndex = excerpt.indexOf(anchor);
  const before = excerpt.slice(0, anchorIndex);
  const after = excerpt.slice(anchorIndex + anchor.length);

  return (
    <>
      {before}
      <span
        data-testid="work-layer-lens-anchor"
        className="border-b-2 border-foreground bg-foreground/[0.07] font-semibold"
      >
        {anchor}
      </span>
      {after}
    </>
  );
}

export function ResolveLensDetails({ finding }: ResolveLensDetailsProps) {
  const { t } = useTranslation();

  return (
    <>
      <div className="mt-4 rounded-sm border border-foreground/30 p-3">
        <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
          SOURCE · <span>{finding.source.label}</span>
        </div>
        <blockquote className="mt-2 border-l-2 border-foreground/40 pl-3 text-sm leading-relaxed">
          {renderAnchoredExcerpt(finding) ??
            t("workLayer.lens.sourceMissing", "現在の本文にAnchorがありません")}
        </blockquote>
      </div>

      <dl className="mt-4 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-2 text-xs">
        <dt className="font-mono text-[8px] tracking-[0.12em] text-muted-foreground">
          {t("workLayer.lens.reason", "理由")}
        </dt>
        <dd>{finding.reason}</dd>
        <dt className="font-mono text-[8px] tracking-[0.12em] text-muted-foreground">
          {t("workLayer.lens.previous", "以前")}
        </dt>
        <dd>{finding.previousValue}</dd>
      </dl>

      <section
        aria-label={t("workLayer.lens.impact", "影響")}
        className="mt-4 rounded-sm border border-foreground/30 p-3"
      >
        <div className="font-mono text-[8px] tracking-[0.14em] text-muted-foreground">
          IMPACT
        </div>
        <ul className="mt-2 space-y-1 text-xs">
          {finding.impact.map((item) => (
            <li key={item} className="flex gap-2">
              <span aria-hidden="true">◇</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
