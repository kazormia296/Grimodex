export type WorkspaceSurface = "editor" | string;

export interface WorkspacePresentationPort {
  openPanel(panelId: string): void;
  openEditor(): void;
  goBack(): void;
  openSurface?(surface: WorkspaceSurface): void;
}
