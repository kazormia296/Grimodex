import type { PanelId } from "../panelIds";

/** Lightweight stand-in for layout Storybook stories. */
export function LayoutStoryPanelStub({ panelId }: { panelId: PanelId }) {
  return (
    <div
      data-story-panel={panelId}
      className="flex h-full min-h-0 w-full items-center justify-center bg-muted/20 text-sm text-muted-foreground"
    >
      {panelId}
    </div>
  );
}
