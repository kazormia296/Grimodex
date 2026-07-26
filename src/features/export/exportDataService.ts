import { db } from "@/db/client";
import { treeNodes } from "@/db/schema";
import { eq } from "drizzle-orm";
import { useSceneContentStore } from "@/features/editor/sceneContentStore";
import { getCurrentProjectId } from "@/features/project/projectStore";
import { saveTextFile } from "@/lib/exportFile";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { resolveStoredTateChuYoko } from "./exportPresets";
import type { ExportPresetId, ExportSettings } from "./types";
import { DEFAULT_EXPORT_SETTINGS, EXPORT_SETTING_KEYS } from "./types";

export function loadSettingsFromStore(
  store: ReturnType<typeof useSettingsStore.getState>,
): ExportSettings {
  const exportPresetId = (store.get(EXPORT_SETTING_KEYS.exportPresetId) ||
    DEFAULT_EXPORT_SETTINGS.exportPresetId) as ExportPresetId;
  return {
    format: (store.get(EXPORT_SETTING_KEYS.format) ||
      DEFAULT_EXPORT_SETTINGS.format) as ExportSettings["format"],
    folderHeading: store.getBoolean(
      EXPORT_SETTING_KEYS.folderHeading,
      DEFAULT_EXPORT_SETTINGS.folderHeading,
    ),
    folderHeadingStyle: (store.get(EXPORT_SETTING_KEYS.folderHeadingStyle) ||
      DEFAULT_EXPORT_SETTINGS.folderHeadingStyle) as ExportSettings["folderHeadingStyle"],
    sceneDivider: (store.get(EXPORT_SETTING_KEYS.sceneDivider) ||
      DEFAULT_EXPORT_SETTINGS.sceneDivider) as ExportSettings["sceneDivider"],
    sceneDividerCustom: store.get(EXPORT_SETTING_KEYS.sceneDividerCustom, ""),
    sceneTitle: (store.get(EXPORT_SETTING_KEYS.sceneTitle) ||
      DEFAULT_EXPORT_SETTINGS.sceneTitle) as ExportSettings["sceneTitle"],
    rubyStyle: store.get(EXPORT_SETTING_KEYS.rubyStyle)
      ? (store.get(
          EXPORT_SETTING_KEYS.rubyStyle,
        ) as ExportSettings["rubyStyle"])
      : null,
    emphasisDotsStyle: store.get(EXPORT_SETTING_KEYS.emphasisDotsStyle)
      ? (store.get(
          EXPORT_SETTING_KEYS.emphasisDotsStyle,
        ) as ExportSettings["emphasisDotsStyle"])
      : null,
    sceneBreakStyle: (store.get(EXPORT_SETTING_KEYS.sceneBreakStyle) ||
      DEFAULT_EXPORT_SETTINGS.sceneBreakStyle) as ExportSettings["sceneBreakStyle"],
    sceneBreakCustom: store.get(EXPORT_SETTING_KEYS.sceneBreakCustom, ""),
    includeTrashBin: store.getBoolean(
      EXPORT_SETTING_KEYS.includeTrashBin,
      DEFAULT_EXPORT_SETTINGS.includeTrashBin,
    ),
    folderHeadingFormat: (store.get(EXPORT_SETTING_KEYS.folderHeadingFormat) ||
      DEFAULT_EXPORT_SETTINGS.folderHeadingFormat) as ExportSettings["folderHeadingFormat"],
    pixivChapterNewpage: store.getBoolean(
      EXPORT_SETTING_KEYS.pixivChapterNewpage,
      DEFAULT_EXPORT_SETTINGS.pixivChapterNewpage,
    ),
    narouEmphasisMode: (store.get(EXPORT_SETTING_KEYS.narouEmphasisMode) ||
      DEFAULT_EXPORT_SETTINGS.narouEmphasisMode) as ExportSettings["narouEmphasisMode"],
    tateChuYoko: resolveStoredTateChuYoko(
      store.get(EXPORT_SETTING_KEYS.tateChuYoko),
      exportPresetId,
    ),
    exportPresetId,
  };
}

export async function loadContentMap(): Promise<Record<string, string>> {
  const rows = await db
    .select({ id: treeNodes.id, content: treeNodes.content })
    .from(treeNodes)
    .where(eq(treeNodes.projectId, getCurrentProjectId()));
  const map: Record<string, string> = {};
  for (const row of rows) map[row.id] = row.content;

  for (const [id, content] of Object.entries(
    useSceneContentStore.getState().liveContent,
  )) {
    if (content) map[id] = JSON.stringify(content);
  }
  return map;
}

const FORMAT_EXT: Record<ExportSettings["format"], string> = {
  markdown: "md",
  plaintext: "txt",
  html: "html",
};
const FORMAT_MIME: Record<ExportSettings["format"], string> = {
  markdown: "text/markdown;charset=utf-8",
  plaintext: "text/plain;charset=utf-8",
  html: "text/html;charset=utf-8",
};
const FORMAT_FILTER: Record<
  ExportSettings["format"],
  { name: string; extensions: string[] }
> = {
  markdown: { name: "Markdown", extensions: ["md"] },
  plaintext: { name: "Plain Text", extensions: ["txt"] },
  html: { name: "HTML", extensions: ["html"] },
};

export function saveFile(
  content: string,
  format: ExportSettings["format"],
  defaultName: string,
): Promise<string | null> {
  return saveTextFile(
    `${defaultName}.${FORMAT_EXT[format]}`,
    FORMAT_FILTER[format],
    content,
    FORMAT_MIME[format],
  );
}
