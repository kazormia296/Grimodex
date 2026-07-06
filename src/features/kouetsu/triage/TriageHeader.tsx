import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  FileText,
  FolderTree,
  Globe,
  LayoutGrid,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTreeStore } from "@/features/tree/treeStore";
import { ScopeTreePickerList } from "@/features/tree/ScopeTreePicker";
import { useAnchoredPopover } from "@/components/ui/useAnchoredPopover";
import { useKouetsuStore } from "../kouetsuStore";
import { useFullCheckStore } from "../fullCheckStore";
import { useResolvedKouetsuScope } from "../useResolvedKouetsuScope";
import { openSceneInEditor } from "./issueActions";
import { RunControl } from "./RunControl";

/**
 * 指摘タブのヘッダ行（デザイン 2a）。左にツリースコープピッカー
 * （シーン/フォルダ/プロジェクト、Chat と同セマンティクス）、右に
 * 全体チェック分割ボタン（RunControl）と観点ダッシュボードのトグル。
 * ステータスフィルタ chips はリストツールバー（IssueList）へ移動した。
 */
export function TriageHeader() {
  const { t } = useTranslation();
  // 宙に浮いた folder anchor は project へ正規化した scope を表示/選択に使う。
  // 書き込み（setScope）は生 store に対して行う（非対称は既存設計どおり）。
  const scope = useResolvedKouetsuScope();
  const setScope = useKouetsuStore((s) => s.setScope);
  const dashboardOn = useKouetsuStore((s) => s.dashboardOn);
  const toggleDashboard = useKouetsuStore((s) => s.toggleDashboard);
  const closePipeline = useFullCheckStore((s) => s.closePipeline);
  const nodes = useTreeStore((s) => s.nodes);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popover = useAnchoredPopover(
    triggerRef,
    open,
    () => setOpen(false),
    "bottom-start",
  );

  const label = (() => {
    if (scope.type === "project") return t("kouetsu.scope.project");
    if (scope.type === "folder") {
      const folder = nodes.find((n) => n.id === scope.anchorId);
      if (!folder) return t("kouetsu.scope.project");
      const kindLabel =
        folder.parentId === null
          ? t("chat.scope.act")
          : t("chat.scope.chapter");
      return `${kindLabel}: ${folder.title}`;
    }
    const scene = nodes.find((n) => n.id === activeSceneId);
    return scene
      ? `${t("kouetsu.scope.current")}: ${scene.title}`
      : t("kouetsu.scope.current");
  })();

  const ScopeIcon =
    scope.type === "project"
      ? Globe
      : scope.type === "folder"
        ? FolderTree
        : FileText;

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-1 text-xs">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex min-w-0 items-center gap-1 rounded-md border border-border bg-background px-1.5 py-0.5",
          "text-foreground hover:bg-accent",
        )}
        title={t("kouetsu.scopePicker")}
      >
        <ScopeIcon className="h-3 w-3 shrink-0 text-[var(--kouetsu-accent)]" />
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        <RunControl />
        <button
          type="button"
          aria-pressed={dashboardOn}
          onClick={() => {
            // 設計 2a: ダッシュボードトグルは選択（toggleDashboard 内で解除）と
            // パイプライン表示を解除する。closePipeline は実行中なら表示のみ
            // 畳み（run 継続・ピルから復帰可）、完了後なら idle へ戻して閉じる。
            closePipeline();
            toggleDashboard();
          }}
          title={t("kouetsu.triage.dashboardToggle")}
          aria-label={t("kouetsu.triage.dashboardToggle")}
          className={cn(
            "flex items-center rounded-md border p-1",
            dashboardOn
              ? "border-[var(--kouetsu-accent)]/40 bg-[var(--kouetsu-accent-weak)] text-[var(--kouetsu-accent)]"
              : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
          )}
        >
          <LayoutGrid size={13} />
        </button>
      </div>

      {open &&
        popover.style &&
        createPortal(
          <div
            ref={popover.popoverRef}
            style={popover.style}
            className="z-[100] w-72 overflow-hidden rounded-md border border-border bg-popover shadow-lg"
          >
            <ScopeTreePickerList
              selection={
                scope.type === "scene"
                  ? activeSceneId
                    ? { type: "scene", sceneId: activeSceneId }
                    : null
                  : scope
              }
              editorActiveSceneId={activeSceneId || undefined}
              onPickScene={(sceneId) => {
                openSceneInEditor(sceneId);
                setScope({ type: "scene" });
                setOpen(false);
              }}
              onPickFolder={(folderId) => {
                setScope({ type: "folder", anchorId: folderId });
                setOpen(false);
              }}
              onPickProject={() => {
                setScope({ type: "project" });
                setOpen(false);
              }}
            />
          </div>,
          document.body,
        )}
    </div>
  );
}
