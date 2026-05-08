/**
 * 単純な「破壊的操作の確認」モーダル (設計書 §9.4 / §15 Phase 7)。
 * 既存 Radix Dialog を薄くラップし、`useConfirmDialog()` で window.confirm 風に
 * 使えるようにする (約束を返し、await できる)。
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 破壊的操作 (赤系ボタン)。default true。 */
  destructive?: boolean;
}

interface ConfirmDialogState extends ConfirmRequest {
  resolve: (ok: boolean) => void;
}

interface UseConfirmDialogResult {
  /** await して true/false を受け取る。 */
  confirm: (req: ConfirmRequest) => Promise<boolean>;
  /** Render 用の Element (使う側の JSX に置く)。 */
  dialog: React.ReactNode;
}

/**
 * `const { confirm, dialog } = useConfirmDialog();` と書き、
 * `{dialog}` をレンダ、`if (await confirm({...})) ...` で使う。
 */
export function useConfirmDialog(): UseConfirmDialogResult {
  const { t } = useTranslation();
  const [state, setState] = useState<ConfirmDialogState | null>(null);

  const confirm = useCallback(
    (req: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        setState({ ...req, resolve });
      }),
    [],
  );

  const handleClose = useCallback(
    (ok: boolean) => {
      if (state) state.resolve(ok);
      setState(null);
    },
    [state],
  );

  const dialog = state ? (
    <Dialog open onOpenChange={(open) => !open && handleClose(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{state.title}</DialogTitle>
          <DialogDescription>{state.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2 sm:justify-end">
          <button
            type="button"
            onClick={() => handleClose(false)}
            className="rounded-md border border-input px-3 py-1.5 text-sm hover:bg-muted"
          >
            {state.cancelLabel ?? t("common.cancel", "キャンセル")}
          </button>
          <button
            type="button"
            autoFocus
            onClick={() => handleClose(true)}
            className={
              (state.destructive ?? true)
                ? "rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground hover:bg-destructive/90"
                : "rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            }
          >
            {state.confirmLabel ?? t("common.confirm", "OK")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ) : null;

  return { confirm, dialog };
}
