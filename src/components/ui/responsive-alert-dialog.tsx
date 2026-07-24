import type { ReactNode, RefObject } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useWorkspaceViewportProfile } from "@/runtime/workspaceViewportContext";

interface ResponsiveAlertDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

export function ResponsiveAlertDialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  testId,
  restoreFocusRef,
}: ResponsiveAlertDialogProps) {
  const phoneWorkspace = useWorkspaceViewportProfile() === "phone";

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        role="alertdialog"
        showClose={false}
        data-testid={testId}
        className={cn(
          className,
          phoneWorkspace &&
            "h-[var(--visual-viewport-height,100dvh)] w-screen max-h-none max-w-none content-start overflow-y-auto rounded-none border-0 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]",
        )}
        onCloseAutoFocus={(event) => {
          if (!restoreFocusRef) return;
          event.preventDefault();
          const focusTarget = restoreFocusRef.current;
          if (focusTarget) {
            focusTarget.focus();
            return;
          }
          window.setTimeout(() => restoreFocusRef.current?.focus(), 0);
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
