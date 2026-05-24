import type { RubyStyle, EmphasisDotsStyle } from "../types";

export interface ZipExportSettings {
  includeMarks: boolean;
  includeChats: boolean;
  includeSnippets: boolean;
  includeMaps: boolean;
  rubyFormatForArchive: RubyStyle;
  emphasisDotsFormatForArchive: EmphasisDotsStyle;
}

export const DEFAULT_ZIP_EXPORT_SETTINGS: ZipExportSettings = {
  includeMarks: true,
  includeChats: true,
  includeSnippets: true,
  includeMaps: true,
  rubyFormatForArchive: "parentheses",
  emphasisDotsFormatForArchive: "double-angle",
};

export interface ArchiveFileEntry {
  path: string;
  content: Uint8Array;
}

export interface ScenePathInfo {
  sceneId: string;
  relativePath: string;
  slug: string;
}
