import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Import,
  FileArchive,
  FileText,
  X,
  type LucideIcon,
} from "lucide-react";
import { AnimatedOverlay } from "@/components/ui/animated-overlay";
import { cn } from "@/lib/utils";
import { ImportDialogBody } from "@/features/import/ImportDialog";
import { ZipExportBody } from "@/features/export/ZipExportDialog";
import { NovelExportBody } from "@/features/export/NovelExportDialog";
import { useWorkspaceViewportProfile } from "@/runtime/workspaceViewportContext";

export type TransferTab = "import" | "zip" | "novel";

interface Props {
  open: boolean;
  tab: TransferTab;
  onTabChange: (tab: TransferTab) => void;
  onClose: () => void;
}

const TABS: { id: TransferTab; labelKey: string; Icon: LucideIcon }[] = [
  { id: "import", labelKey: "transfer.tab.import", Icon: Import },
  { id: "zip", labelKey: "transfer.tab.zip", Icon: FileArchive },
  { id: "novel", labelKey: "transfer.tab.novel", Icon: FileText },
];

/**
 * インポート / エクスポート（ZIP・AIのべりすと）を 1 つに束ねたタブ付きダイアログ。
 * 各タブ本体は既存の *Body コンポーネントをそのまま再利用する。
 */
export function TransferDialog({ open, tab, onTabChange, onClose }: Props) {
  const { t } = useTranslation();
  const phoneWorkspace = useWorkspaceViewportProfile() === "phone";
  const [importBusy, setImportBusy] = useState(false);
  const [importFailed, setImportFailed] = useState(false);
  const importInteractionLocked = importBusy || importFailed;
  const handleClose = useCallback(() => {
    if (!(tab === "import" && importBusy)) onClose();
  }, [importBusy, onClose, tab]);

  return (
    <AnimatedOverlay
      open={open}
      onClose={handleClose}
      testId="transfer-dialog"
      className={cn(
        "flex min-h-0 min-w-0 overflow-hidden border border-border bg-background shadow-xl outline-none",
        phoneWorkspace
          ? "h-[var(--visual-viewport-height,100dvh)] w-screen max-h-none max-w-none flex-col rounded-none border-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
          : "h-[min(600px,85vh)] w-[760px] max-w-[92vw] rounded-lg",
      )}
    >
      <nav
        role="tablist"
        aria-label={t("transfer.tablistLabel")}
        aria-orientation={phoneWorkspace ? "horizontal" : "vertical"}
        className={cn(
          "flex flex-shrink-0 gap-0.5 border-border p-2",
          phoneWorkspace
            ? "w-full overscroll-x-contain overflow-x-auto border-b"
            : "w-[150px] flex-col border-r",
        )}
      >
        {TABS.map(({ id, labelKey, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`transfer-tab-${id}`}
            onClick={() => {
              if (!(tab === "import" && importInteractionLocked)) {
                onTabChange(id);
              }
            }}
            disabled={tab === "import" && importInteractionLocked}
            className={cn(
              "flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
              phoneWorkspace && "min-h-11 shrink-0 whitespace-nowrap",
              tab === id
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            <span className="truncate">{t(labelKey)}</span>
          </button>
        ))}
      </nav>

      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("transfer.dialogTitle")}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col",
          phoneWorkspace ? "overflow-hidden p-4 pt-14" : "p-6",
        )}
      >
        <button
          type="button"
          onClick={handleClose}
          disabled={tab === "import" && importBusy}
          aria-label={t("common.close")}
          className={cn(
            "absolute right-3 top-3 z-10 rounded text-muted-foreground hover:bg-accent",
            phoneWorkspace
              ? "flex min-h-11 min-w-11 items-center justify-center"
              : "p-1",
          )}
        >
          <X className="h-4 w-4" aria-hidden />
        </button>

        <div
          role="tabpanel"
          data-testid="transfer-dialog-panel"
          className={cn(
            "flex min-h-0 min-w-0 flex-1 flex-col",
            phoneWorkspace &&
              "overflow-x-hidden overflow-y-auto overscroll-contain [&_button]:min-h-11",
          )}
        >
          {tab === "import" && (
            <ImportDialogBody
              onClose={onClose}
              onBusyChange={setImportBusy}
              onFailureChange={setImportFailed}
            />
          )}
          {tab === "zip" && <ZipExportBody onClose={onClose} />}
          {tab === "novel" && <NovelExportBody onClose={onClose} />}
        </div>
      </div>
    </AnimatedOverlay>
  );
}
