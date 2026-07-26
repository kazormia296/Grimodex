import { useEffect, useRef, type ReactNode, type Ref } from "react";
import { X } from "lucide-react";

interface PhoneSceneMetaSheetProps {
  phoneWorkspace: boolean;
  open: boolean;
  title: string;
  closeLabel: string;
  onClose: () => void;
  closeButtonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}

/**
 * Native full-screen dialog used only by the phone editor projection.
 * The surface owns native dialog lifecycle and viewport/safe-area bounds while
 * EditorPane owns focus restoration and open state.
 */
export function PhoneSceneMetaSheet({
  phoneWorkspace,
  open,
  title,
  closeLabel,
  onClose,
  closeButtonRef,
  children,
}: PhoneSceneMetaSheetProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!phoneWorkspace || !open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    return () => {
      if (!dialog.open) return;
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    };
  }, [phoneWorkspace, open]);

  if (!phoneWorkspace || !open) return null;

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      aria-modal="true"
      data-phone-scene-meta-sheet
      data-testid="phone-scene-meta-sheet"
      className="fixed inset-0 z-30 m-0 h-[var(--visual-viewport-height,100dvh)] max-h-none w-screen max-w-none overflow-hidden border-0 bg-background pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-foreground backdrop:bg-black/40"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="flex h-full min-h-0 min-w-0 flex-col">
        <header className="flex min-h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="min-w-0 text-base font-semibold">{title}</h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label={closeLabel}
            onClick={onClose}
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </header>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</div>
      </div>
    </dialog>
  );
}
