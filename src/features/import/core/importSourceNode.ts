export type ImportSourceNodeKind = "folder" | "scene" | "document";

export interface ImportSourceNode {
  readonly key: string;
  readonly parentKey: string | null;
  readonly title: string;
  readonly orderIndex: number;
  readonly kind: ImportSourceNodeKind;
}
