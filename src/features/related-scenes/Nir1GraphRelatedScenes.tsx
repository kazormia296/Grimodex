import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { debugLog } from "@/lib/debugLog";
import { Nir1RelatedSceneRow } from "./Nir1RelatedSceneRow";
import { requestNir1EvidenceNavigation } from "./nir1EvidenceNavigation";
import { Nir1GraphPathEvidence, Nir1GraphText } from "./Nir1GraphPathEvidence";
import {
  fuseNir1RelatedScenesGraph,
  type Nir1GraphOnlyDisplayRow,
} from "./nir1GraphFusion";
import { ensureNir1GraphTranslations } from "./nir1GraphTranslations";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

ensureNir1GraphTranslations();

interface Props {
  readonly fetch: Nir1RelatedScenesFetchResult;
  readonly querySceneId: string;
}

function GraphOnlyRow({
  row,
  fetch,
}: {
  readonly row: Nir1GraphOnlyDisplayRow;
  readonly fetch: Nir1RelatedScenesFetchResult;
}) {
  const { t } = useTranslation();
  const { graphOnly } = row;
  // Native re-qualifies twice (before opening and after the editor loads);
  // the editor text at the range must equal the excerpt (DR-CP3B-10).
  const open = () =>
    void requestNir1EvidenceNavigation(
      fetch,
      row.sceneId,
      graphOnly.navigationIdentity,
      { canonicalRange: graphOnly.canonicalRange, excerpt: graphOnly.excerpt },
    );
  return (
    <div
      data-testid="related-scene-row"
      data-related-scene-id={row.sceneId}
      data-nir1-graph-only="true"
      className="flex min-w-0 flex-col gap-1 px-2 py-1.5"
    >
      <span className="flex w-full min-w-0 items-center gap-2">
        <span className="flex-1 truncate text-xs font-medium text-foreground">
          {row.sceneTitle ? (
            <Nir1GraphText value={row.sceneTitle} />
          ) : (
            t("relatedScenes.untitled")
          )}
        </span>
        <span
          className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-medium text-muted-foreground"
          title={t("relatedScenes.graph.graphOnlyMarkLabel")}
        >
          <span aria-hidden="true">
            {t("relatedScenes.graph.graphOnlyMark")}
          </span>
          <span className="sr-only">
            {t("relatedScenes.graph.graphOnlyMarkLabel")}
          </span>
        </span>
        <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary">
          {t("relatedScenes.rank", { rank: row.rank })}
        </span>
      </span>
      <div className="min-w-0 border-l-2 border-primary/20 pl-2 text-[11px]">
        <p className="text-muted-foreground">
          {t("relatedScenes.graph.bodyExcerpt")}
        </p>
        <button
          type="button"
          data-testid="nir1-graph-only-open"
          data-nir1-navigation-identity={graphOnly.navigationIdentity}
          onClick={open}
          className="mt-1 w-full min-w-0 cursor-pointer text-left text-primary hover:underline"
        >
          <span className="block">{t("relatedScenes.graph.openExcerpt")}</span>
          <span className="line-clamp-3 break-words">
            <Nir1GraphText value={graphOnly.excerpt} />
          </span>
        </button>
      </div>
      <Nir1GraphPathEvidence
        hop={graphOnly.path.hop}
        edges={graphOnly.path.edges}
      />
    </div>
  );
}

/**
 * The Related Scenes rows with a `graph-ready` Graph (CP-3b). A lazy chunk:
 * requested only while `NIR1_GRAPH_UI_ENABLED` is on and the fetch carries a
 * Graph payload or `restart-required` (DR-CP3B-7). `fetch.result` is read,
 * never changed.
 */
export default function Nir1GraphRelatedScenes({ fetch, querySceneId }: Props) {
  const { t } = useTranslation();
  const fusion = useMemo(
    () =>
      fuseNir1RelatedScenesGraph({
        result: fetch.result,
        queryBinding: fetch.queryBinding,
        querySceneId,
        graphOutcome: fetch.graphOutcome,
        graph: fetch.graph,
      }),
    [fetch, querySceneId],
  );
  const { attachments, graphOnly } = fusion.dropped;
  useEffect(() => {
    if (attachments > 0 || graphOnly > 0)
      // Counts only: never a title, excerpt, path text or ID.
      debugLog.warn("related-scenes", "graph contribution narrowed", {
        sensitivity: "safe",
        fields: { attachments, graphOnly },
      });
  }, [attachments, graphOnly, fusion]);
  const restart = fetch.graphOutcome === "graph-unavailable:restart-required";
  return (
    <>
      {restart && (
        <p
          role="status"
          data-testid="nir1-graph-restart-required"
          className="px-3 py-2 text-[11px] text-muted-foreground"
        >
          {t("relatedScenes.graph.restartRequired")}
        </p>
      )}
      {fusion.rows.length === 0 ? (
        <p className="px-3 py-2 text-[11px] text-muted-foreground">
          {t("relatedScenes.empty")}
        </p>
      ) : (
        fusion.rows.map((row) =>
          row.kind === "graph-only" ? (
            <GraphOnlyRow key={row.sceneId} row={row} fetch={fetch} />
          ) : (
            <Nir1RelatedSceneRow
              key={row.sceneId}
              sceneId={row.sceneId}
              sceneTitle={row.sceneTitle}
              rank={row.rank}
              raw={row.raw}
              ir={row.ir}
              fetch={fetch}
            >
              {row.path && (
                <Nir1GraphPathEvidence
                  hop={row.path.hop}
                  edges={row.path.edges}
                />
              )}
            </Nir1RelatedSceneRow>
          ),
        )
      )}
    </>
  );
}
