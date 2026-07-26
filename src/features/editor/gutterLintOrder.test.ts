// @vitest-environment happy-dom
/**
 * bug2 順序契約の統合テスト。
 *
 * GutterMarksPlugin は review ガター記号のため LintDecorationPlugin の
 * decoration state を apply 時に読む。TipTap の ExtensionManager は登録順を
 * 反転して PM プラグイン列を作る (`sortExtensions([...extensions].reverse())`)
 * ため、GutterMarksExtension を lint より後に登録しただけでは gutter の PM
 * プラグインが lint より **先** に適用され、gutter が未計算の lint state を読む。
 * GutterMarksExtension に低 priority を付けて gutter を最後に回すことで解消する。
 *
 * この統合テストは **実体の** LintDecorationExtension / GutterMarksExtension を
 * TipTap の Editor (= 実際の ExtensionManager 順序解決) 経由で積み、Lint 指摘
 * だけの段落に review ガター記号が出ることを確認する。priority を外すと
 * gutter が lint より先に走り hasLint が常に false になりこのテストは落ちる。
 * (単体テスト GutterMarksPlugin.test.ts は plugins 配列を手組みするため順序
 * 契約は gate しない — ここで gate する。)
 */
import { describe, it, expect, beforeEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

import { LintDecorationExtension, GutterMarksExtension } from "./extensions";
import { setLintDiagnostics } from "./LintDecorationPlugin";
import { gutterMarksKey } from "./GutterMarksPlugin";
import { useCursorSettingsStore } from "./cursorSettingsStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import type { Diagnostic } from "@/features/lint/types";

function reviewWidgetKeys(editor: Editor): string[] {
  const set = gutterMarksKey.getState(editor.state);
  if (!set) return [];
  return set
    .find()
    .map((d) => (d.spec as { key?: string }).key ?? "")
    .filter((k) => k.includes("review"));
}

const SENTENCE_LEN_DIAG: Diagnostic = {
  rule_id: "ja/sentence-length",
  severity: "warning",
  message: "一文が長すぎます",
  range: { start: 0, end: 6 },
};

beforeEach(() => {
  // review を Lint 由来だけに絞る: 校閲アノテーションは OFF。
  useAnnotationStore.setState({
    showAnnotations: false,
    showReaderComments: false,
  });
  useCursorSettingsStore.setState({
    showComments: false,
    showForeshadowMarks: false,
    showLint: true,
  });
});

describe("gutter × lint プラグイン順序契約 (bug2)", () => {
  function makeEditor(): Editor {
    const el = document.createElement("div");
    document.body.appendChild(el);
    // 登録順は production (extensions.ts) と同じく lint → gutter。
    // TipTap が反転するので、priority 無しなら gutter が先に走る。
    return new Editor({
      element: el,
      extensions: [StarterKit, LintDecorationExtension, GutterMarksExtension],
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "これはとても長い一文です。" }],
          },
        ],
      },
    });
  }

  it("Lint 指摘だけの段落に review ガター記号が出る (実プラグイン順)", () => {
    const editor = makeEditor();
    try {
      expect(reviewWidgetKeys(editor)).toHaveLength(0);
      setLintDiagnostics(editor.view, [SENTENCE_LEN_DIAG]);
      expect(reviewWidgetKeys(editor)).toEqual(["gutter-0-review"]);
    } finally {
      editor.destroy();
    }
  });

  it("showLint OFF なら Lint 由来 review ガターは出ない", () => {
    useCursorSettingsStore.setState({ showLint: false });
    const editor = makeEditor();
    try {
      setLintDiagnostics(editor.view, [SENTENCE_LEN_DIAG]);
      expect(reviewWidgetKeys(editor)).toHaveLength(0);
    } finally {
      editor.destroy();
    }
  });
});
