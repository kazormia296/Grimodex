import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { useLayoutStore } from "@/features/layout/layoutStore";
import { useMapStore } from "./mapStore";
import { generateCausalityBoard } from "./causalityBoard";

/**
 * timeline_consistency の causality 注釈からシーン因果地図 (Map board) を生成し、
 * 生成後に Map パネルへ遷移するボタン。AI は使わない (既存注釈の再構成のみ)。
 * 校閲 MetaStructure (テンション波形の隣) に置く。
 */
export function CausalityMapButton({
  projectId,
}: {
  projectId: string | null;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  // setBusy(state) は非同期反映なので、連打の二重生成 (= 重複 board) を防ぐには
  // 同期的な re-entry ガードが要る。
  const busyRef = useRef(false);

  async function handleClick() {
    if (!projectId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await generateCausalityBoard(projectId);
      if (!result.boardId) {
        // 解決可能な因果辺なし (timeline_consistency 未実行 or 因果指摘ゼロ)。
        toast.info(t("map.causality.noEdgesToast"));
        return;
      }
      useMapStore.getState().setActiveBoardId(result.boardId);
      useLayoutStore.getState().showPanel("map");
      toast.success(
        result.cycleCount > 0
          ? t("map.causality.generatedWithCycles", {
              edges: result.edgeCount,
              cycles: result.cycleCount,
            })
          : t("map.causality.generated", { edges: result.edgeCount }),
      );
    } catch (e) {
      toast.error(
        t("map.causality.failed", {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy || !projectId}
      className="flex items-center gap-1.5 self-start rounded border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : (
        <Workflow className="h-3 w-3" />
      )}
      <span>{t("map.causality.generateButton")}</span>
    </button>
  );
}
