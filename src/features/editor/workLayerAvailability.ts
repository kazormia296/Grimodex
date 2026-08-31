interface WorkLayerAvailabilityInput {
  readonly lifecycleLocked: boolean;
  readonly editorZenMode: boolean;
  readonly phoneWorkspace: boolean;
  readonly panelWindow: boolean;
  readonly screenshotPanelId: string | null;
}

export function isWorkLayerAvailable({
  lifecycleLocked,
  editorZenMode,
  phoneWorkspace,
  panelWindow,
  screenshotPanelId,
}: WorkLayerAvailabilityInput): boolean {
  return (
    !lifecycleLocked &&
    !editorZenMode &&
    !phoneWorkspace &&
    !panelWindow &&
    screenshotPanelId == null
  );
}
