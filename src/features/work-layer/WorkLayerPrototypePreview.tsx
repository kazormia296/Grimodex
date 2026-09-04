import { useMemo, useState } from "react";

import { WorkLayerProvider } from "./WorkLayerContext";
import { WorkLayerPrototypeRouter } from "./WorkLayerPrototypeRouter";
import { WorkLayerPrototypeToolbar } from "./WorkLayerPrototypeToolbar";
import { WorkLayerSurface } from "./WorkLayerSurface";
import { WorkPulse } from "./WorkPulse";
import {
  modelForPrototypeMode,
  type WorkLayerPrototypeMode,
} from "./workLayerPrototype";

export type { WorkLayerPrototypeMode } from "./workLayerPrototype";

interface WorkLayerPrototypePreviewProps {
  readonly initialMode?: WorkLayerPrototypeMode;
}

export function WorkLayerPrototypePreview({
  initialMode = "ambient",
}: WorkLayerPrototypePreviewProps) {
  const [mode, setMode] = useState(initialMode);
  const [modelMode, setModelMode] = useState(initialMode);
  const [routeRevision, setRouteRevision] = useState(0);
  const model = useMemo(() => modelForPrototypeMode(modelMode), [modelMode]);
  const selectPrototypeMode = (nextMode: WorkLayerPrototypeMode) => {
    setModelMode(nextMode);
    setMode(nextMode);
    setRouteRevision((current) => current + 1);
  };

  return (
    <div className="flex h-[800px] flex-col bg-background text-foreground">
      <WorkLayerPrototypeToolbar
        mode={mode}
        onModeChange={selectPrototypeMode}
      />

      <WorkLayerProvider
        key={`${modelMode}:${routeRevision}`}
        initialModel={model}
      >
        <WorkLayerPrototypeRouter mode={mode} onModeChange={setMode} />
        <div
          data-work-layer-preview-background
          className="flex min-h-0 flex-1 flex-col"
        >
          <header className="flex h-12 items-center justify-center border-b border-border">
            <WorkPulse />
          </header>
          <main className="relative min-h-0 flex-1 overflow-hidden bg-muted/30 p-4">
            <div
              className={
                model.codexPanelAvailable === false
                  ? "grid h-full grid-cols-[14rem_1fr] gap-3 opacity-70"
                  : "grid h-full grid-cols-[14rem_1fr_18rem] gap-3 opacity-70"
              }
            >
              <div className="rounded-2xl border border-border bg-card p-4">
                Scenes
              </div>
              <div className="rounded-2xl border border-border bg-card p-6">
                Editor
              </div>
              {model.codexPanelAvailable !== false && (
                <div className="rounded-2xl border border-border bg-card p-4">
                  Codex
                </div>
              )}
            </div>
            <WorkLayerSurface />
          </main>
        </div>
      </WorkLayerProvider>
    </div>
  );
}
