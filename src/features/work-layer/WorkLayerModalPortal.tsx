import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function WorkLayerModalPortal({
  children,
}: {
  readonly children: ReactNode;
}) {
  const host = useMemo(() => document.createElement("div"), []);
  const [mounted, setMounted] = useState(false);

  useLayoutEffect(() => {
    host.dataset.workLayerModalHost = "true";
    document.body.appendChild(host);
    const scopedBackground =
      document.querySelector<HTMLElement>(".app-shell") ??
      document.querySelector<HTMLElement>(
        "[data-work-layer-preview-background]",
      );
    const appRoot = document.getElementById("root");
    const appRootBackground =
      scopedBackground != null &&
      appRoot != null &&
      appRoot.contains(scopedBackground)
        ? Array.from(appRoot.children)
        : scopedBackground == null
          ? []
          : [scopedBackground];
    const bodySiblings = Array.from(document.body.children).filter(
      (element) =>
        element !== host &&
        (scopedBackground == null || !element.contains(scopedBackground)),
    );
    const background = Array.from(
      new Set(
        scopedBackground == null
          ? bodySiblings
          : [...appRootBackground, ...bodySiblings],
      ),
    );
    const snapshots = background.map((element) => ({
      element,
      inert: element.getAttribute("inert"),
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const element of background) {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    }
    setMounted(true);

    return () => {
      for (const snapshot of snapshots) {
        if (snapshot.inert == null) snapshot.element.removeAttribute("inert");
        else snapshot.element.setAttribute("inert", snapshot.inert);
        if (snapshot.ariaHidden == null) {
          snapshot.element.removeAttribute("aria-hidden");
        } else {
          snapshot.element.setAttribute("aria-hidden", snapshot.ariaHidden);
        }
      }
      host.remove();
    };
  }, [host]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]');
    if (dialog == null) return;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter((element) => element.getAttribute("aria-hidden") !== "true");
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first == null || last == null) return;
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !dialog.contains(active))) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (
      !event.shiftKey &&
      (active === last || !dialog.contains(active))
    ) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  if (!mounted) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[100]"
      data-work-layer-modal-root
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>,
    host,
  );
}
