import { useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;

    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();

      // Read initial state
      setIsMaximized(await win.isMaximized());

      // Track changes
      unlisten = await win.onResized(async () => {
        setIsMaximized(await win.isMaximized());
      });
    })();

    return () => {
      unlisten?.();
    };
  }, []);

  if (!isTauri()) return null;

  async function minimize() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().minimize();
  }

  async function toggleMaximize() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().toggleMaximize();
  }

  async function close() {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().close();
  }

  return (
    <div className="flex items-center">
      <button
        type="button"
        title="最小化"
        onClick={minimize}
        className="flex h-8 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title={isMaximized ? "元に戻す" : "最大化"}
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
        title="閉じる"
        onClick={close}
        className="flex h-8 w-10 items-center justify-center text-muted-foreground transition-colors hover:bg-red-600 hover:text-white"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
