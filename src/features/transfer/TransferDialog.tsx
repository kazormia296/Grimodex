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

  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      className="flex h-[min(600px,85vh)] w-[760px] max-w-[92vw] overflow-hidden rounded-lg border border-border bg-background shadow-xl outline-none"
    >
      <nav
        role="tablist"
        aria-label={t("transfer.tablistLabel")}
        aria-orientation="vertical"
        className="flex w-[150px] flex-shrink-0 flex-col gap-0.5 border-r border-border p-2"
      >
        {TABS.map(({ id, labelKey, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            data-testid={`transfer-tab-${id}`}
            onClick={() => onTabChange(id)}
            className={cn(
              "flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition-colors",
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
        className="relative flex min-h-0 min-w-0 flex-1 flex-col p-6"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="absolute right-3 top-3 z-10 rounded p-1 text-muted-foreground hover:bg-accent"
        >
          <X className="h-4 w-4" />
        </button>

        <div role="tabpanel" className="flex min-h-0 flex-1 flex-col">
          {tab === "import" && <ImportDialogBody onClose={onClose} />}
          {tab === "zip" && <ZipExportBody onClose={onClose} />}
          {tab === "novel" && <NovelExportBody onClose={onClose} />}
        </div>
      </div>
    </AnimatedOverlay>
  );
}
