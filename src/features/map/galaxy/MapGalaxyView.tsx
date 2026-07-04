import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentProjectId } from "@/features/project/projectStore";
import { useEnsureCodexTypeColors } from "@/features/codex/useEnsureCodexTypeColors";
import { useTabStore } from "@/features/editor/tabStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useChronicleStore } from "@/features/chronicle/chronicleStore";
import { useTimelineStore } from "@/features/timeline/timelineStore";
import { useMapStore } from "../mapStore";
import { loadGalaxyGraphInput } from "../galaxyData";
import {
  buildGalaxyGraph,
  applyGalaxyFilters,
  type GalaxyGraph,
  type GalaxyNode,
} from "../galaxyGraph";
import { GalaxyCanvas } from "./GalaxyCanvas";
import { GalaxyFilterPanel } from "./GalaxyFilterPanel";

function detectWebgl(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/**
 * ギャラクシービューのコンテナ。データロード・状態分岐・フィルタ配線・
 * ノードジャンプを担い、3D 描画は GalaxyCanvas に委譲する。
 */
export function MapGalaxyView() {
  const { t } = useTranslation();
  const projectId = useCurrentProjectId();
  const galaxyFilters = useMapStore((s) => s.galaxyFilters);
  const setGalaxyFilters = useMapStore((s) => s.setGalaxyFilters);
  useEnsureCodexTypeColors();

  const [raw, setRaw] = useState<GalaxyGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const webglAvailable = useMemo(detectWebgl, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    loadGalaxyGraphInput(projectId)
      .then((input) => {
        if (!cancelled) setRaw(buildGalaxyGraph(input));
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloadKey]);

  const filtered = useMemo(
    () => (raw ? applyGalaxyFilters(raw, galaxyFilters) : null),
    [raw, galaxyFilters],
  );

  // シングルクリック: 各エンティティを対応パネルで選択状態にする
  const handleSelectNode = useCallback((node: GalaxyNode) => {
    switch (node.kind) {
      case "scene":
        useTreeStore.getState().setActiveScene(node.refId);
        break;
      case "codex":
        useCodexStore.getState().requestSelectEntry(node.refId);
        break;
      case "event":
        useChronicleStore.getState().setSelectedEventId(node.refId);
        break;
      case "thread":
        useTimelineStore.getState().setSelectedPlotThreadId(node.refId);
        break;
    }
  }, []);

  const handleOpenNode = useCallback((node: GalaxyNode) => {
    if (node.kind === "scene") {
      useTabStore.getState().openPinned(node.refId);
    } else if (node.kind === "codex") {
      useCodexStore.getState().requestSelectEntry(node.refId);
    }
    // event / thread は v1 ではジャンプ先なし（選択+カメラフォーカスのみ）
  }, []);

  const empty =
    !loading && !loadFailed && raw !== null && raw.nodes.length === 0;
  const showCanvas =
    !loading && !loadFailed && !empty && webglAvailable && filtered !== null;

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#05060f]">
      {loading && (
        <CenterMessage>
          <RefreshCw className="size-4 animate-spin" aria-hidden />
          {t("map.galaxy.loading")}
        </CenterMessage>
      )}
      {loadFailed && <CenterMessage>{t("map.galaxy.loadError")}</CenterMessage>}
      {empty && <CenterMessage>{t("map.galaxy.empty")}</CenterMessage>}
      {!loading && !loadFailed && !empty && !webglAvailable && (
        <CenterMessage>{t("map.galaxy.noWebgl")}</CenterMessage>
      )}
      {showCanvas && (
        <GalaxyCanvas
          graph={filtered}
          onSelectNode={handleSelectNode}
          onOpenNode={handleOpenNode}
        />
      )}
      {!loading && !loadFailed && (
        <div className="absolute left-3 top-3 z-10">
          <Button
            variant="outline"
            size="xs"
            onClick={() => setReloadKey((k) => k + 1)}
            title={t("map.galaxy.refresh")}
            className="bg-background/80 backdrop-blur"
          >
            <RefreshCw className="size-3" aria-hidden />
            {t("map.galaxy.refresh")}
          </Button>
        </div>
      )}
      {showCanvas && (
        <GalaxyFilterPanel
          filters={galaxyFilters}
          onChange={setGalaxyFilters}
        />
      )}
    </div>
  );
}

function CenterMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        {children}
      </p>
    </div>
  );
}

export default MapGalaxyView;
