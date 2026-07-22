import { useEffect } from "react";
import { BackgroundStudio } from "./BackgroundStudio";
import { useBackgroundStudioStore } from "./backgroundStudioStore";

export function BackgroundStudioHost({ zenMode }: { zenMode: boolean }) {
  const open = useBackgroundStudioStore((state) => state.open);
  const setOpen = useBackgroundStudioStore((state) => state.setOpen);

  useEffect(() => {
    if (zenMode) setOpen(false);
  }, [setOpen, zenMode]);

  return (
    <BackgroundStudio
      open={open && !zenMode}
      onClose={() => setOpen(false)}
      zenMode={zenMode}
    />
  );
}
