import { useTranslation } from "react-i18next";
import { useTreeStore } from "@/features/tree/treeStore";
import { requestSceneChunkJump } from "@/features/semantic-search/sceneChunkJump";
import { requestNir1EvidenceNavigation } from "./nir1EvidenceNavigation";
import type { RelatedScene } from "./selectRelatedScenes";
import type { Nir1AdmittedScene } from "./nir1RelatedScenesResult";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";

interface Props {
  readonly sceneId: string;
  readonly sceneTitle: string;
  readonly rank?: number;
  readonly raw?: RelatedScene;
  readonly ir?: Nir1AdmittedScene;
  readonly fetch: Nir1RelatedScenesFetchResult;
}

export function Nir1RelatedSceneRow({
  sceneId,
  sceneTitle,
  rank,
  raw,
  ir,
  fetch,
}: Props) {
  const { t } = useTranslation();
  const openEvidence = () => {
    if (ir)
      void requestNir1EvidenceNavigation(
        fetch,
        sceneId,
        ir.validatedEvidence.navigationIdentity,
      );
  };
  const openScene = () => {
    if (!useTreeStore.getState().nodes.some((node) => node.id === sceneId))
      return;
    if (raw) requestSceneChunkJump(sceneId, raw.chunkText);
    else openEvidence();
  };
  return (
    <div
      data-testid="related-scene-row"
      data-related-scene-id={sceneId}
      className="flex flex-col gap-1 px-2 py-1.5"
    >
      <button
        type="button"
        onClick={openScene}
        className="flex w-full cursor-pointer flex-col gap-0.5 text-left hover:bg-accent/50"
      >
        <span className="flex w-full items-center gap-2">
          <span className="flex-1 truncate text-xs font-medium text-foreground">
            {sceneTitle || t("relatedScenes.untitled")}
          </span>
          <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[10px] font-medium text-primary">
            {rank === undefined && raw
              ? `${Math.round(raw.score * 100)}%`
              : t("relatedScenes.rank", { rank })}
          </span>
        </span>
        {raw && (
          <span className="line-clamp-2 text-[11px] text-muted-foreground">
            {raw.chunkText}
          </span>
        )}
      </button>
      {ir && (
        <div className="border-l-2 border-primary/20 pl-2 text-[11px]">
          <p className="text-muted-foreground">
            {t("relatedScenes.approvedInterpretation")} ·{" "}
            {t("relatedScenes.fresh")}
          </p>
          <p>{ir.interpretation.summary}</p>
          <dl className="text-muted-foreground">
            <div>
              <dt className="inline">{t("relatedScenes.actuality")}: </dt>
              <dd className="inline">{ir.interpretation.actuality}</dd>
            </div>
            <div>
              <dt className="inline">{t("relatedScenes.attribution")}: </dt>
              <dd className="inline">{ir.interpretation.attribution}</dd>
            </div>
            <div>
              <dt className="inline">{t("relatedScenes.narrativeFrame")}: </dt>
              <dd className="inline">{ir.interpretation.narrativeFrame}</dd>
            </div>
          </dl>
          <button
            type="button"
            data-testid="nir1-evidence-link"
            data-nir1-navigation-identity={
              ir.validatedEvidence.navigationIdentity
            }
            onClick={openEvidence}
            className="mt-1 cursor-pointer text-left text-primary hover:underline"
          >
            <span className="block">{t("relatedScenes.openEvidence")}</span>
            <span className="line-clamp-2">{ir.validatedEvidence.excerpt}</span>
          </button>
        </div>
      )}
    </div>
  );
}
