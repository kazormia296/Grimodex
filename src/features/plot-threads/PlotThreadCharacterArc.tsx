import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { sceneCodexMentions } from "@/db/schema";
import { usePlotThreadStore } from "./plotThreadStore";
import { useCodexStore } from "@/features/codex/codexStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useMatrixDataVersionStore } from "@/features/matrix/matrixDataVersion";
import {
  computeThreadCharacterArc,
  type ArcMentionRow,
} from "./threadCharacterArc";

const MAX_ROWS = 8;

/**
 * Phase 4b: 選択中スレッドの「主要キャラ」ランキング（読み取り専用）。
 * sceneCodexMentions を糸の所属シーンに絞って codex 軸で再集約し、POV を加味する。
 * matrix（scene×codex グリッド）とは別の thread 境界ランキング。
 */
export function PlotThreadCharacterArc({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const links = usePlotThreadStore((s) => s.links);
  const entries = useCodexStore((s) => s.entries);
  const nodes = useTreeStore((s) => s.nodes);
  const dataVersion = useMatrixDataVersionStore((s) => s.version);
  const [mentions, setMentions] = useState<ArcMentionRow[]>([]);

  const threadNodeIds = useMemo(() => {
    const s = new Set<string>();
    for (const l of links) if (l.threadId === threadId) s.add(l.nodeId);
    return [...s];
  }, [links, threadId]);

  // 糸のシーンに絞って mention をロード（mention 書き込みで bump される dataVersion を購読）。
  useEffect(() => {
    if (threadNodeIds.length === 0) {
      setMentions([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      void db
        .select({
          sceneId: sceneCodexMentions.sceneId,
          codexEntryId: sceneCodexMentions.codexEntryId,
          source: sceneCodexMentions.source,
          role: sceneCodexMentions.role,
        })
        .from(sceneCodexMentions)
        .where(inArray(sceneCodexMentions.sceneId, threadNodeIds))
        .then((rows) => {
          if (!cancelled) setMentions(rows as ArcMentionRow[]);
        })
        .catch(() => {
          if (!cancelled) setMentions([]);
        });
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [threadNodeIds, dataVersion]);

  const povByScene = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const n of nodes) {
      if (n.nodeType === "scene") m.set(n.id, n.povCharacterId);
    }
    return m;
  }, [nodes]);

  const entryById = useMemo(
    () => new Map(entries.map((e) => [e.id, e] as const)),
    [entries],
  );

  const arc = useMemo(
    () => computeThreadCharacterArc(links, threadId, mentions, povByScene),
    [links, threadId, mentions, povByScene],
  );

  // 「主要キャラ」= character 型のみ・score>0 か POV。relation のみ(score0)は除外。
  const ranked = arc
    .filter((a) => {
      const e = entryById.get(a.codexEntryId);
      return e?.type === "character" && (a.score > 0 || a.isPov);
    })
    .slice(0, MAX_ROWS);

  if (ranked.length === 0) return null;

  return (
    <div
      data-testid={`plot-thread-arc-${threadId}`}
      className="flex flex-col gap-1 border-t border-border pt-3"
    >
      <span className="font-semibold text-foreground">
        {t("plotThread.arc.title", "この糸の主要キャラ")}
      </span>
      <span className="text-[10px] text-muted-foreground">
        {t("plotThread.arc.hint", "所属シーンでの登場・役割・POV から集計")}
      </span>
      <ul className="flex flex-col gap-0.5">
        {ranked.map((a) => {
          const entry = entryById.get(a.codexEntryId);
          return (
            <li
              key={a.codexEntryId}
              className="flex items-center gap-2 text-xs"
            >
              <span className="min-w-0 flex-1 truncate text-foreground">
                {entry?.name || t("plotThread.unnamed", "（無名）")}
              </span>
              {a.isPov && (
                <span className="shrink-0 rounded bg-primary/15 px-1 text-[10px] font-medium text-primary">
                  {t("plotThread.arc.pov", "POV")}
                </span>
              )}
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {t("plotThread.arc.sceneCount", "{{n}}シーン", {
                  n: a.sceneCount,
                })}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
