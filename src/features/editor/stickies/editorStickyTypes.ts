import type { DocumentKey } from "@/features/editor/document/documentKey";

export const EMPTY_STICKY_BODY = '{"type":"doc","content":[]}';

export interface EditorSticky {
  id: string;
  projectId: string;
  documentKey: DocumentKey;
  body: string;
  paletteId: string;
  colorSlot: number;
  inlineOffset: number;
  blockOffset: number;
  zIndex: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface EditorStickyPatch {
  body?: string;
  paletteId?: string;
  colorSlot?: number;
  inlineOffset?: number;
  blockOffset?: number;
  zIndex?: number;
}
