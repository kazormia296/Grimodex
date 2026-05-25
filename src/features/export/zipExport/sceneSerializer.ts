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
    // Archive may be re-imported by a Grimodex instance with strict line
    // breaks enabled, where a bare `\n` collapses into a soft break and
    // loses the hardBreak node. Emit the CommonMark spec marker (`  \n`)
    // so the archive round-trips regardless of the receiver's setting.
    strictLineBreaks: true,
  });

  const marks = settings.includeMarks
    ? extractMarksFromPmDoc(contentJson ?? "{}")
    : null;

  return { markdown, marks };
}
