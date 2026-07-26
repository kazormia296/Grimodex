import { useEffect, useRef } from "react";
import type { HTMLAttributes, KeyboardEvent } from "react";
import { AnimatedOverlay } from "./animated-overlay";
import { cn } from "@/lib/utils";
import { useViewportProfile } from "@/runtime/useViewportProfile";
import type { WorkspaceViewportProfile } from "@/runtime/viewportProfile";

let nextDialogId = 0;

export interface ResponsiveDialogProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "title"
> {
  open: boolean;
  onClose: () => void;
  title: string;
  profile?: WorkspaceViewportProfile;
  presentation?: "modal" | "sheet";
  testId?: string;
}

function useBrowserBackClose(open: boolean, onClose: () => void): void {
  const marker = useRef<string | null>(null);
  if (marker.current === null)
    marker.current = `grimodex-responsive-dialog-${++nextDialogId}`;
  const pushed = useRef(false);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const dialogMarker = marker.current;
    if (dialogMarker === null) return;
    const currentState = window.history.state;
    const state =
      typeof currentState === "object" && currentState !== null
        ? currentState
        : {};
    window.history.pushState(
      { ...state, __grimodexResponsiveDialog: dialogMarker },
      "",
      window.location.href,
    );
    pushed.current = true;

    const handlePopState = () => {
      if (!pushed.current) return;
      pushed.current = false;
      onCloseRef.current();
    };
    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      if (
        pushed.current &&
        window.history.state?.__grimodexResponsiveDialog === dialogMarker
      ) {
        pushed.current = false;
        window.history.back();
      }
    };
  }, [open]);
}

export function ResponsiveDialog({
  open,
  onClose,
  title,
  profile: profileOverride,
  presentation = "modal",
  className,
  children,
  testId,
  ...attributes
}: ResponsiveDialogProps) {
  const { profile, ref } = useViewportProfile({ observeNode: false });
  const activeProfile = profileOverride ?? profile;
  useBrowserBackClose(open, onClose);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const native = event.nativeEvent;
    if (
      event.key === "Escape" &&
      (native.isComposing || event.keyCode === 229)
    ) {
      // AnimatedOverlay listens at window. Stop propagation only while IME is
      // composing so a normal Escape retains the existing close behavior.
      event.stopPropagation();
    }
  };

  const surfaceClassName = cn(
    "relative flex flex-col overflow-hidden border border-border bg-background shadow-2xl outline-none",
    activeProfile === "phone"
      ? "h-[100dvh] w-full rounded-none border-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
      : activeProfile === "compact" && presentation === "sheet"
        ? "max-h-[85dvh] w-full self-end rounded-t-xl"
        : activeProfile === "compact"
          ? "max-h-[85dvh] w-[min(520px,calc(100vw-2rem))] rounded-xl"
          : "max-h-[min(720px,90dvh)] w-[min(640px,calc(100vw-2rem))] rounded-xl",
    className,
  );

  return (
    <AnimatedOverlay
      open={open}
      onClose={onClose}
      className={surfaceClassName}
      testId={testId}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-dialog-profile={activeProfile}
        data-dialog-presentation={presentation}
        className={surfaceClassName}
        onKeyDown={handleKeyDown}
        {...attributes}
      >
        {children}
      </div>
    </AnimatedOverlay>
  );
}
