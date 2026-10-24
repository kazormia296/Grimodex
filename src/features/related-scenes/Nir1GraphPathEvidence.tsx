import { useTranslation } from "react-i18next";
import type { RelatedScenesGraphPathEdge } from "@/../electron/shared/relatedScenesSearchWire";

// Line breaks, C0/C1 controls and bidi controls (ALM, LRM, RLM, LRE..RLO,
// LRI..PDI, LS, PS). Display only: the value itself is never changed and is
// never what a comparison or navigation uses (D9, DR-CP3B-6).
const DISPLAY_BREAKERS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g;

export function nir1GraphDisplayText(value: string): string {
  return value.replace(DISPLAY_BREAKERS, " ");
}

/** An isolated (bidi) span of display-normalized text. */
export function Nir1GraphText({
  value,
  className,
}: {
  readonly value: string;
  readonly className?: string;
}) {
  return <bdi className={className}>{nir1GraphDisplayText(value)}</bdi>;
}

interface Props {
  readonly hop: number;
  readonly edges: readonly RelatedScenesGraphPathEdge[];
}

/**
 * The Graph path Evidence of one row: the edges as a list (both Entity labels,
 * the relation type, the directionality) and each relation's Evidence quotes,
 * shown apart from the body anchor. It offers no navigation (CP-3a D8) and
 * every edge and quote of the payload is shown (G-06).
 */
export function Nir1GraphPathEvidence({ hop, edges }: Props) {
  const { t } = useTranslation();
  return (
    <section
      data-testid="nir1-graph-path"
      aria-label={t("relatedScenes.graph.pathHeading")}
      className="min-w-0 border-l-2 border-muted-foreground/30 pl-2 text-[11px] text-muted-foreground"
    >
      <p className="font-medium">
        {t("relatedScenes.graph.pathHeading")} ·{" "}
        {t("relatedScenes.graph.pathHop", { hop })}
      </p>
      <ol className="flex min-w-0 flex-col gap-1">
        {edges.map((edge, at) => {
          const direction =
            edge.directionality === "directed"
              ? t("relatedScenes.graph.directed")
              : edge.directionality === "symmetric"
                ? t("relatedScenes.graph.symmetric")
                : t("relatedScenes.graph.directionUnknown");
          const glyph =
            edge.directionality === "directed"
              ? "→"
              : edge.directionality === "symmetric"
                ? "↔"
                : "–";
          return (
            <li key={at} data-testid="nir1-graph-path-edge" className="min-w-0">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-1">
                <Nir1GraphText
                  value={edge.from.label}
                  className="min-w-0 break-words text-foreground"
                />
                <span aria-hidden="true" title={direction}>
                  {glyph}
                </span>
                <span className="sr-only">{direction}</span>
                <Nir1GraphText
                  value={edge.to.label}
                  className="min-w-0 break-words text-foreground"
                />
                <span className="min-w-0 break-words">
                  (<Nir1GraphText value={edge.relationType} />)
                </span>
              </span>
              {edge.evidence.length > 0 && (
                <div className="min-w-0">
                  <span className="block">
                    {t("relatedScenes.graph.relationEvidence")}
                  </span>
                  <ul className="flex min-w-0 flex-col gap-0.5">
                    {edge.evidence.map((evidence, index) => (
                      <li key={index} className="min-w-0">
                        <blockquote
                          data-testid="nir1-graph-relation-quote"
                          className="line-clamp-3 min-w-0 break-words italic"
                        >
                          <Nir1GraphText value={evidence.quote} />
                        </blockquote>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
