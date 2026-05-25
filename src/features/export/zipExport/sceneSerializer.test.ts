import { describe, it, expect } from "vitest";
import { serializeSceneContent } from "./sceneSerializer";
import { DEFAULT_ZIP_EXPORT_SETTINGS } from "./types";

/**
 * Archive markdown は zip 経由で別ユーザー / 別 mode の Grimodex に
 * `importApi.markdownToPmJson` 経由で再 import され得る。受信側が
 * `editor.markdownStrictLineBreaks=true` (CommonMark 互換) のとき、bare
 * `\n` での hardBreak は soft break (空白) に潰れて消失するため、archive 側
 * は CommonMark 仕様の hardBreak マーカー (`  \n`) を常に出力する。
 *
 * cf. memory/grimodex-archive-strict-hardbreak-followup.md
 */
describe("serializeSceneContent — hardBreak round-trip safety", () => {
  it("emits `  \\n` for hardBreak so cross-mode re-import preserves the node", () => {
    const pm = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: "hardBreak" },
            { type: "text", text: "b" },
          ],
        },
      ],
    });
    const { markdown } = serializeSceneContent(pm, DEFAULT_ZIP_EXPORT_SETTINGS);
    expect(markdown).toContain("a  \nb");
    expect(markdown).not.toMatch(/a\nb/); // bare `\n` ではない
  });

  it("treats consecutive hardBreaks correctly (each gets the `  \\n` marker)", () => {
    const pm = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "a" },
            { type: "hardBreak" },
            { type: "text", text: "b" },
            { type: "hardBreak" },
            { type: "text", text: "c" },
          ],
        },
      ],
    });
    const { markdown } = serializeSceneContent(pm, DEFAULT_ZIP_EXPORT_SETTINGS);
    expect(markdown).toContain("a  \nb  \nc");
  });
});
