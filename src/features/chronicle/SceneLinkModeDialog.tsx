import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { SceneLinkMode } from "./SceneLinkField";

export interface SceneLinkModeDialogProps {
  /** 追加しようとしているシーンのタイトル（本文の差し込み用）。 */
  sceneTitle: string;
  /** イベント優先 / シーン優先 を選んだ。 */
  onChoose: (mode: SceneLinkMode) => void;
  /** 取り消し（Esc・背景クリック・キャンセルボタン）。 */
  onCancel: () => void;
}

/**
 * 「シーンを追加」で **日時が設定済み** のシーンを選んだときにだけ出す、リンク時の
 * 優先方向を尋ねる軽量モーダル。イベント優先＝シーンの日時/POV/場所をこのイベントの
 * 値で上書き、シーン優先＝関連付けのみでシーン側の日時を保持。
 *
 * Radix ではなく自前の overlay にしているのは、他の Radix ダイアログが happy-dom で
 * 単体テストされていない一方、SceneLinkField は happy-dom で fireEvent テストされて
 * いるため。portal/FocusScope/pointer-events の罠を避けて素直にテストできる。
 */
export function SceneLinkModeDialog({
  sceneTitle,
  onChoose,
  onCancel,
}: SceneLinkModeDialogProps) {
  const { t } = useTranslation();
  const eventBtnRef = useRef<HTMLButtonElement | null>(null);

  // 開いたら主ボタンへフォーカス。Esc で取り消し。
  useEffect(() => {
    eventBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div
      data-testid="link-mode-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        // 背景（overlay 自身）クリックのみ取り消し。パネル内クリックは無視。
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-mode-dialog-title"
        className="grid w-full max-w-sm gap-3 rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl"
      >
        <div className="flex flex-col gap-1">
          <span
            id="link-mode-dialog-title"
            className="text-sm font-medium text-foreground"
          >
            {t("chronicle.linkModeDialogTitle", "リンク時の優先")}
          </span>
          <span className="text-xs text-muted-foreground">
            {t(
              "chronicle.linkModeDialogBody",
              "「{{title}}」には日時が設定されています。どちらを優先しますか？",
              {
                title:
                  sceneTitle || t("chronicle.untitledScene", "無題のシーン"),
              },
            )}
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <button
            ref={eventBtnRef}
            type="button"
            data-testid="link-mode-dialog-event"
            onClick={() => onChoose("event")}
            className="flex flex-col items-start rounded-md border border-border px-3 py-2 text-start hover:bg-accent"
          >
            <span className="text-xs font-medium text-foreground">
              {t("chronicle.linkModeEvent", "イベント優先")}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {t(
                "chronicle.linkModeEventHint",
                "シーンの日時/POV/場所をこのイベントの値で上書きします。",
              )}
            </span>
          </button>
          <button
            type="button"
            data-testid="link-mode-dialog-scene"
            onClick={() => onChoose("scene")}
            className="flex flex-col items-start rounded-md border border-border px-3 py-2 text-start hover:bg-accent"
          >
            <span className="text-xs font-medium text-foreground">
              {t("chronicle.linkModeScene", "シーン優先")}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {t(
                "chronicle.linkModeSceneHint",
                "関連付けのみ。シーン側の日時を保持します。",
              )}
            </span>
          </button>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            data-testid="link-mode-dialog-cancel"
            onClick={onCancel}
            className="rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            {t("common.cancel", "キャンセル")}
          </button>
        </div>
      </div>
    </div>
  );
}
