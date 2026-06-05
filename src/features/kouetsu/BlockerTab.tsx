import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ListRowSkeletonList } from "@/components/ui/skeleton-patterns";
import { useTreeStore } from "@/features/tree/treeStore";
import { useLensStore } from "@/features/post-effect/lensStore";
import { computeLensDotState } from "@/features/tree/LensDot";
import { useTrashBinStore } from "@/features/trash-bin/trashBinStore";
import { listForeshadowsWithLabels } from "@/features/foreshadow/api";
import type { ForeshadowWithLabel } from "@/features/foreshadow/types";
import {
  deriveBlockers,
  totalBlockerCount,
  type BlockerGroup,
  type BlockerInput,
  type BlockerSeverity,
} from "./deriveBlockers";

const SEVERITY_DOT: Record<BlockerSeverity, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-slate-400",
};

/** info グループは件数が多くなりがちなので既定で畳む。 */
const DEFAULT_COLLAPSED: BlockerSeverity = "info";

/** 1 グループあたりの最大表示件数 (超過分はヘッダ件数で示すので silent cap ではない)。 */
const MAX_ENTRIES = 100;

/**
 * Tier A-3: ブロッカー / 次にやること ダッシュボード (Kouetsu タブ)。
 * 各パネルが既に計算済のシグナルを deriveBlockers で 1 ビューに集約する。
 * lazy ロードのストア (lens / foreshadow / trash) は自前でハイドレートする。
 */
export function BlockerTab() {
  const { t } = useTranslation();
  const projectId = useTreeStore((s) => s.projectId);
  const nodes = useTreeStore((s) => s.nodes);
  const nodePreviews = useTreeStore((s) => s.nodePreviews);
  const lensBySceneId = useLensStore((s) => s.bySceneId);
  const trashItems = useTrashBinStore((s) => s.items);
  const [foreshadows, setForeshadows] = useState<ForeshadowWithLabel[] | null>(
    null,
  );

  useEffect(() => {
    if (!projectId) {
      setForeshadows([]);
      return;
    }
    let cancelled = false;
    setForeshadows(null);
    void useLensStore.getState().load(projectId);
    void useTrashBinStore.getState().loadItems(projectId);
    listForeshadowsWithLabels(projectId)
      .then((r) => {
        if (!cancelled) setForeshadows(r.items);
      })
      .catch(() => {
        if (!cancelled) setForeshadows([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const input: BlockerInput = useMemo(() => {
    const scenes = nodes
      .filter((n) => n.nodeType === "scene" && n.archivedAt == null)
      .map((n) => {
        const recs = lensBySceneId.get(n.id);
        const lens =
          recs && recs.length ? computeLensDotState(recs, n.updatedAt) : null;
        return {
          id: n.id,
          title: n.title,
          intent: n.intent,
          isLoose: n.parentId == null,
          hasUnplacedBeats: (nodePreviews[n.id]?.unplaced ?? null) != null,
          lens,
        };
      });
    const salvageableTrash = [...trashItems.values()]
      .filter((it) => it.isInteresting)
      .map((it) => ({
        id: it.id,
        label: it.previewText || t("kouetsu.blocker.untitled"),
      }));
    return {
      foreshadows: (foreshadows ?? []).map((f) => ({
        id: f.id,
        title: f.title,
        label: f.label,
      })),
      scenes,
      salvageableTrash,
    };
  }, [nodes, nodePreviews, lensBySceneId, trashItems, foreshadows, t]);

  const groups = useMemo(() => deriveBlockers(input), [input]);

  if (foreshadows === null) {
    return <ListRowSkeletonList testId="blocker-tab-loading" className="p-3" />;
  }

  if (groups.length === 0) {
    return (
      <div
        data-testid="blocker-tab-empty"
        className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground"
      >
        {t("kouetsu.blocker.empty")}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        {t("kouetsu.blocker.summary", { count: totalBlockerCount(groups) })}
      </div>
      <div
        data-testid="blocker-tab-list"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {groups.map((group) => (
          <BlockerGroupRow key={group.kind} group={group} />
        ))}
      </div>
    </div>
  );
}

function BlockerGroupRow({ group }: { group: BlockerGroup }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(
    group.severity !== DEFAULT_COLLAPSED,
  );
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const shown = group.entries.slice(0, MAX_ENTRIES);
  const overflow = group.entries.length - shown.length;

  return (
    <div className="border-b border-border/60">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs hover:bg-accent"
      >
        <Chevron className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "h-2 w-2 shrink-0 rounded-full",
            SEVERITY_DOT[group.severity],
          )}
          aria-hidden="true"
        />
        <span className="truncate font-medium">
          {t(`kouetsu.blocker.kind.${group.kind}`)}
        </span>
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
          {group.entries.length}
        </span>
      </button>
      {expanded && (
        <ul className="pb-1">
          {shown.map((entry) => {
            const clickable = entry.sceneId != null;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  disabled={!clickable}
                  onClick={() => {
                    if (entry.sceneId) {
                      useTreeStore.getState().setActiveScene(entry.sceneId);
                    }
                  }}
                  className={cn(
                    "w-full truncate px-3 py-1 pl-9 text-left text-xs text-muted-foreground",
                    clickable
                      ? "hover:bg-accent hover:text-foreground"
                      : "cursor-default",
                  )}
                >
                  {entry.label || t("kouetsu.blocker.untitled")}
                </button>
              </li>
            );
          })}
          {overflow > 0 && (
            <li className="px-3 py-1 pl-9 text-[10px] text-muted-foreground/70">
              {t("kouetsu.blocker.more", { count: overflow })}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
