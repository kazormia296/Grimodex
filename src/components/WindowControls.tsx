import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Minus, Square, Copy, X } from "lucide-react";
import { isMac } from "@/lib/platform";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import { isTauri } from "@/lib/tauri";
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  onWindowResized,
  toggleMaximizeWindow,
} from "@/lib/windowControls";

export function WindowControls() {
  const { t } = useTranslation();
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri() || isMac()) return;

    let unlisten: (() => void) | undefined;

    (async () => {
      // Read initial state
      setIsMaximized(await isWindowMaximized());

      // Track changes
      unlisten = await onWindowResized(() => {
        void isWindowMaximized().then(setIsMaximized);
      });
    })();

    return () => {
      unlisten?.();
    };
  }, []);

  if (!isTauri() || isMac()) return null;

  async function minimize() {
    await minimizeWindow();
  }

  async function toggleMaximize() {
    await toggleMaximizeWindow();
  }

  async function close() {
    // 未確定の inline-AI diff があれば終了を止める (即時フィードバック)。
    // Mac ネイティブ閉じる / OS 経由の close は App の onCloseRequested が veto する。
    if (guardInlineAiPending()) return;
    await closeWindow();
  }

  return (
    <div className="flex items-center">
      <button
        type="button"
        aria-label={t("window.minimize")}
        title={t("window.minimize")}
        onClick={minimize}
        className="flex h-8 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        aria-label={isMaximized ? t("window.restore") : t("window.maximize")}
        title={isMaximized ? t("window.restore") : t("window.maximize")}
        onClick={toggleMaximize}
        className="flex h-8 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {isMaximized ? (
          <Copy className="h-3.5 w-3.5" />
        ) : (
          <Square className="h-3.5 w-3.5" />
        )}
      </button>
      <button
        type="button"
        aria-label={t("window.close")}
        title={t("window.close")}
        onClick={close}
        className="flex h-8 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-red-600 hover:text-white"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
