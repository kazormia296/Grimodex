import type { KeyboardEvent, RefObject } from "react";
import { cn } from "@/lib/utils";

interface WorkspaceMenuTriggerProps {
  triggerRef: RefObject<HTMLButtonElement | null>;
  workspaceLabel: string;
  projectTitle: string;
  /** 読み込みに欠けがあるときの読み上げの補足（`project.loadDegraded`）。 */
  degradedLabel: string | null;
  isOpen: boolean;
  /** 開いている間だけ aria-controls で指すパネルの id。 */
  panelId: string;
  busy: boolean;
  workspaceOpenRevision: number;
  onToggle: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
}

/**
 * 名前がこの文字数以下なら最小幅を付けずに縮めない（省略記号を入れる幅も無い
 * 短い名前を切らない。最小幅より短い名前で空きも作らない）。
 */
const SHORT_WORKSPACE_CHARS = 3;
const SHORT_TITLE_CHARS = 2;

function charCount(text: string): number {
  return Array.from(text).length;
}

/**
 * 統合メニューのトリガー。「フォルダ名 / 題名」を 1 本で出す。
 *
 * DOM の契約（Electron の product journey が頼っている）:
 * - ボタンの中の最初の span がフォルダ名で、文字はフォルダ名だけ。隠すときも DOM に残す。
 * - 題名の span（`project-menu-trigger`）は常に描画し、幅が 0 にならない。
 *
 * 幅は中身に合わせ（上限 320px）、足りないときはフォルダ名が先に縮む。
 * ヘッダーではロゴの後ろの 3 つ（このメニュー・元に戻す／やり直す・書き出し）を
 * 名前付きの container（`@container/header-menu`、EditorWorkspaceHeader）に入れて
 * いる。メニューの後ろの固定分は 132px なので、その内容幅が 288px 未満
 * （メニューに残る幅が、フォルダ名を出すときの最小幅 約 135〜147px を切る）なら
 * フォルダ名と「/」を隠して題名だけにする。phone の「その他」は container の外。
 * button は overflow-hidden で、名前が隣の要素へはみ出さず button の中で切れる。
 *
 * 題名の最小幅は 1.5em（クリックできる中心が残る幅）。フォルダ名を出す幅では
 * 閾値の決め方から題名に 3em 以上が残る。フォルダ名を隠す狭い幅（800px の窓など）
 * では題名のほうを縮め、▾ が button の外へ押し出されて切れないようにする。
 */
export function WorkspaceMenuTrigger({
  triggerRef,
  workspaceLabel,
  projectTitle,
  degradedLabel,
  isOpen,
  panelId,
  busy,
  workspaceOpenRevision,
  onToggle,
  onKeyDown,
}: WorkspaceMenuTriggerProps) {
  const fullLabel = `${workspaceLabel} / ${projectTitle}`;
  // 題名がフォルダ名と同じなら、フォルダ名と「/」を隠して 1 つにまとめる。
  const workspaceHidden = workspaceLabel === projectTitle;
  const shortWorkspace = charCount(workspaceLabel) <= SHORT_WORKSPACE_CHARS;
  const titleChars = charCount(projectTitle);
  const shortTitle = titleChars > 0 && titleChars <= SHORT_TITLE_CHARS;
  const hideWhenMenuNarrow = "@max-[288px]/header-menu:hidden";

  return (
    <button
      ref={triggerRef}
      type="button"
      data-testid="workspace-menu-trigger"
      data-tour-target="project-menu"
      data-workspace-open-revision={workspaceOpenRevision}
      aria-expanded={isOpen}
      aria-controls={isOpen ? panelId : undefined}
      aria-label={degradedLabel ? `${fullLabel}: ${degradedLabel}` : fullLabel}
      title={fullLabel}
      onClick={onToggle}
      onKeyDown={onKeyDown}
      disabled={busy}
      className="flex max-w-full min-w-0 items-center gap-1 overflow-hidden rounded px-2 py-1 text-sm hover:bg-accent hover:text-accent-foreground"
    >
      <span
        data-workspace-menu-folder
        className={cn(
          "truncate text-muted-foreground",
          shortWorkspace ? "shrink-0" : "min-w-[3.5em] shrink-[1000]",
          workspaceHidden ? "hidden" : hideWhenMenuNarrow,
        )}
      >
        {workspaceLabel}
      </span>
      <span
        aria-hidden
        className={cn(
          "shrink-0 text-muted-foreground",
          workspaceHidden ? "hidden" : hideWhenMenuNarrow,
        )}
      >
        /
      </span>
      <span
        data-testid="project-menu-trigger"
        className={cn(
          "truncate font-medium",
          shortTitle ? "shrink-0" : "min-w-[1.5em]",
        )}
      >
        {projectTitle}
      </span>
      {degradedLabel && (
        <span
          aria-hidden
          className="shrink-0 text-xs font-bold text-amber-600 dark:text-amber-400"
        >
          !
        </span>
      )}
      <span aria-hidden className="shrink-0 text-xs">
        ▾
      </span>
    </button>
  );
}
