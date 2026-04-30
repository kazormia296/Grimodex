interface SceneMetaPanelProps {
  sceneId: string;
}

export function SceneMetaPanel({ sceneId: _sceneId }: SceneMetaPanelProps) {
  return (
    <div
      data-testid="scene-meta-panel"
      className="flex w-72 flex-shrink-0 flex-col overflow-y-auto border-l border-border bg-muted/20"
    />
  );
}
