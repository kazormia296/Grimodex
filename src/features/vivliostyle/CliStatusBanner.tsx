import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CheckCircle2, ClipboardCopy, XCircle } from "lucide-react";
import type { VivliostyleDetectResult } from "./types";

// ────────────────────────────────────────────────────────────────────
// CLI 検出状態バナー。
// 未検出時は Node.js + `npm install -g @vivliostyle/cli` の導入ガイドと
// 手動バイナリパス入力・再検出ボタンを出す（AiCategory の binary path
// SettingRow + 自動検出の流儀）。
// ────────────────────────────────────────────────────────────────────

const INSTALL_COMMAND = "npm install -g @vivliostyle/cli";

interface Props {
  /** undefined = 検出中、null = 未検出 */
  detected: VivliostyleDetectResult | null | undefined;
  binaryPath: string;
  onBinaryPathChange: (path: string) => void;
  onRedetect: () => void;
}

export function CliStatusBanner({
  detected,
  binaryPath,
  onBinaryPathChange,
  onRedetect,
}: Props) {
  const { t } = useTranslation();
  const [isCopied, setIsCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (detected === undefined) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("vivliostyle.cli.checking")}
      </p>
    );
  }

  if (detected) {
    return (
      <div className="flex items-start gap-2 rounded border border-border bg-muted/30 px-3 py-2 text-xs">
        <CheckCircle2
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500"
          aria-hidden
        />
        <div className="min-w-0">
          <p>{t("vivliostyle.cli.detected", { version: detected.version })}</p>
          <p className="truncate font-mono text-muted-foreground">
            {detected.path}
          </p>
        </div>
      </div>
    );
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(INSTALL_COMMAND);
      setIsCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setIsCopied(false), 1500);
    } catch {
      // クリップボード失敗は無視（コマンドは画面上に表示済み）
    }
  }

  return (
    <div
      data-testid="vivliostyle-cli-guide"
      className="flex flex-col gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
    >
      <div className="flex items-start gap-2">
        <XCircle
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500"
          aria-hidden
        />
        <div>
          <p className="font-medium">{t("vivliostyle.cli.notFound")}</p>
          <p className="mt-0.5 text-muted-foreground">
            {t("vivliostyle.cli.guide")}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-muted/60 px-2 py-1 font-mono">
          {INSTALL_COMMAND}
        </code>
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 hover:bg-accent"
        >
          {isCopied ? (
            <>
              <Check className="h-3 w-3 text-green-500" aria-hidden />
              {t("vivliostyle.cli.copied")}
            </>
          ) : (
            <>
              <ClipboardCopy className="h-3 w-3" aria-hidden />
              {t("vivliostyle.cli.copyCommand")}
            </>
          )}
        </button>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-muted-foreground">
          {t("vivliostyle.cli.manualPath")}
        </span>
        <div className="flex gap-2">
          <input
            type="text"
            value={binaryPath}
            onChange={(e) => onBinaryPathChange(e.target.value)}
            placeholder={t("vivliostyle.cli.manualPathPlaceholder")}
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono focus:outline-none"
          />
          <button
            type="button"
            onClick={onRedetect}
            className="shrink-0 rounded-md border border-border px-2 py-1 hover:bg-accent"
          >
            {t("vivliostyle.cli.redetect")}
          </button>
        </div>
      </label>
    </div>
  );
}
