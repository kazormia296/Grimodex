export interface ImportSourceDocument {
  readonly key: string;
  readonly nodeKey: string;
  readonly title: string;
  readonly orderIndex: number;
  readonly proseMirrorJson: string;
  readonly plainText?: string;
}

export const EMPTY_PROSEMIRROR_DOC = '{"type":"doc","content":[]}' as const;
