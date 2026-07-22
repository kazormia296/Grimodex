import { Palette } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CSS_DURATIONS, CSS_EASINGS, useReducedMotion } from "@/lib/animation";
import { BackgroundStudio } from "./BackgroundStudio";
import { useBackgroundStudioStore } from "./backgroundStudioStore";

export function BackgroundStudioHost({ zenMode }: { zenMode: boolean }) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const open = useBackgroundStudioStore((state) => state.open);
  const setOpen = useBackgroundStudioStore((state) => state.setOpen);

  return (
    <>
      <BackgroundStudio
        open={open}
        onClose={() => setOpen(false)}
        zenMode={zenMode}
      />
      {zenMode && !open && (
        <button
          type="button"
          aria-label={t("editor.background.open")}
          title={t("editor.background.open")}
          onClick={() => setOpen(true)}
          className="fixed bottom-4 right-4 z-[80] rounded-full border border-border/60 bg-popover/75 p-2 text-muted-foreground opacity-45 shadow-lg backdrop-blur hover:bg-popover hover:text-foreground hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          style={{
            transition: reduced
              ? "none"
              : `opacity ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}, color ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}, background-color ${CSS_DURATIONS.fast} ${CSS_EASINGS.easeOut}`,
          }}
        >
          <Palette className="h-4 w-4" />
        </button>
      )}
    </>
  );
}
