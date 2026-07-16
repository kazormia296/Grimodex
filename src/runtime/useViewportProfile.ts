import { useEffect, useRef, useState } from "react";
import {
  resolveViewportProfile,
  type WorkspaceViewportProfile,
} from "./viewportProfile";

export interface ViewportProfileBinding {
  profile: WorkspaceViewportProfile;
  ref: (node: HTMLDivElement | null) => void;
}

export interface UseViewportProfileOptions {
  observeNode?: boolean;
}

function widthOf(node: HTMLDivElement | null): number {
  if (node) {
    const width = node.getBoundingClientRect().width;
    if (width > 0) return width;
  }
  return typeof window === "undefined" ? 1200 : window.innerWidth;
}

export function useViewportProfile({
  observeNode = true,
}: UseViewportProfileOptions = {}): ViewportProfileBinding {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const [profile, setProfile] = useState<WorkspaceViewportProfile>(() =>
    resolveViewportProfile(widthOf(null)),
  );

  useEffect(() => {
    const update = () =>
      setProfile(resolveViewportProfile(widthOf(nodeRef.current)));
    update();
    const node = nodeRef.current;
    const observer =
      observeNode && node && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(update)
        : null;
    if (observer && node) observer.observe(node);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [observeNode]);

  return {
    profile,
    ref: (node) => {
      nodeRef.current = node;
    },
  };
}
