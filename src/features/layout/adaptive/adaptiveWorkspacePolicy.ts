export interface AdaptiveWorkspacePolicyInput {
  featureEnabled: boolean;
  panelWindow: boolean;
  screenshotPanelId: string | null;
}

/** Solo panel and screenshot surfaces must retain their dedicated chrome. */
export function shouldUseAdaptiveWorkspace({
  featureEnabled,
  panelWindow,
  screenshotPanelId,
}: AdaptiveWorkspacePolicyInput): boolean {
  return featureEnabled && !panelWindow && screenshotPanelId === null;
}
