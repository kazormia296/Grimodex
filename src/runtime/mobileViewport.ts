export interface MobileViewportTarget {
  innerHeight: number;
  visualViewport?: {
    height: number;
    addEventListener(type: "resize" | "scroll", listener: () => void): void;
    removeEventListener(type: "resize" | "scroll", listener: () => void): void;
  } | null;
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

export interface MobileViewportStyleTarget {
  style: { setProperty(name: string, value: string): void };
}

export function installMobileViewportVars(
  target: MobileViewportTarget,
  root: MobileViewportStyleTarget,
): () => void {
  const update = () => {
    const visualHeight = target.visualViewport?.height ?? target.innerHeight;
    const keyboardInset = Math.max(0, target.innerHeight - visualHeight);
    root.style.setProperty("--visual-viewport-height", `${visualHeight}px`);
    root.style.setProperty("--keyboard-inset", `${keyboardInset}px`);
  };
  update();
  target.addEventListener("resize", update);
  target.visualViewport?.addEventListener("resize", update);
  target.visualViewport?.addEventListener("scroll", update);
  return () => {
    target.removeEventListener("resize", update);
    target.visualViewport?.removeEventListener("resize", update);
    target.visualViewport?.removeEventListener("scroll", update);
  };
}
