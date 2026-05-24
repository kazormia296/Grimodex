import { renderPmDocToArchiveMarkdown } from "../exportEngine";
import { extractMarksFromPmDoc } from "./marksExtractor";
import type { MarksSidecar } from "./marksExtractor";
import type { ZipExportSettings } from "./types";

export interface SerializedScene {
  markdown: string;
  marks: MarksSidecar | null;
}

export function serializeSceneContent(
  contentJson: string | null | undefined,
  settings: ZipExportSettings,
): SerializedScene {
  const markdown = renderPmDocToArchiveMarkdown(contentJson ?? "{}", {
    rubyStyle: settings.rubyFormatForArchive,
    emphasisDotsStyle: settings.emphasisDotsFormatForArchive,
  });

  const marks = settings.includeMarks
    ? extractMarksFromPmDoc(contentJson ?? "{}")
    : null;

  return { markdown, marks };
}
