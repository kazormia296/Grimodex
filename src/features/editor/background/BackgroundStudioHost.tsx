import { lazy, Suspense, useEffect } from "react";
import { useBackgroundStudioStore } from "./backgroundStudioStore";

const BackgroundStudio = lazy(() =>
  import("./BackgroundStudio").then((module) => ({
    default: module.BackgroundStudio,
  })),
);

export function BackgroundStudioHost({ zenMode }: { zenMode: boolean }) {
  const open = useBackgroundStudioStore((state) => state.open);
  const setOpen = useBackgroundStudioStore((state) => state.setOpen);

  useEffect(() => {
    if (zenMode) setOpen(false);
  }, [setOpen, zenMode]);

  if (!open || zenMode) return null;

  return (
    <Suspense fallback={null}>
      <BackgroundStudio open onClose={() => setOpen(false)} zenMode={zenMode} />
    </Suspense>
  );
}
