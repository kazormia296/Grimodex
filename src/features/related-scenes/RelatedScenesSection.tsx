import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { CollapsibleSection } from "@/features/layout/CollapsibleSection";
import { Nir1RelatedSceneRow } from "./Nir1RelatedSceneRow";
import { useNir1RelatedScenes } from "./useNir1RelatedScenes";

interface RelatedScenesSectionProps {
  enabled?: boolean;
}

export function RelatedScenesSection({
  enabled = true,
}: RelatedScenesSectionProps = {}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const { sceneId, fetch, loading } = useNir1RelatedScenes(enabled && open);
  const result = fetch?.result;
  const unavailable =
    result?.kind === "raw" && result.ir.status === "unavailable"
      ? result.ir.reason
      : null;
  return (
    <CollapsibleSection
      title={t("sceneContext.scenesSection")}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      actions={
        loading ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : null
      }
    >
      <div className="py-1">
        {unavailable && (
          <p
            data-testid="nir1-unavailable"
            className="px-3 py-2 text-[11px] text-muted-foreground"
          >
            {t(
              unavailable === "unsupported-query"
                ? "relatedScenes.irUnsupported"
                : "relatedScenes.irUnavailable",
            )}
          </p>
        )}
        {!sceneId ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            {t("relatedScenes.noActiveScene")}
          </p>
        ) : !fetch || !result?.scenes.length ? (
          <p className="px-3 py-2 text-[11px] text-muted-foreground">
            {t(loading ? "relatedScenes.loading" : "relatedScenes.empty")}
          </p>
        ) : result.kind === "raw" ? (
          result.scenes.map((raw) => (
            <Nir1RelatedSceneRow
              key={raw.sceneId}
              sceneId={raw.sceneId}
              sceneTitle={raw.sceneTitle}
              raw={raw}
              fetch={fetch}
            />
          ))
        ) : (
          result.scenes.map((scene) => (
            <Nir1RelatedSceneRow
              key={scene.sceneId}
              sceneId={scene.sceneId}
              sceneTitle={scene.sceneTitle}
              rank={scene.rank1}
              raw={scene.kind !== "ir" ? scene.raw : undefined}
              ir={scene.kind !== "raw" ? scene.ir : undefined}
              fetch={fetch}
            />
          ))
        )}
      </div>
    </CollapsibleSection>
  );
}
