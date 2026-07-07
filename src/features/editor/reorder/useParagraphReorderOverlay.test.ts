// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { Editor } from "@tiptap/core";
import { invoke } from "@tauri-apps/api/core";
import { getEditorExtensions } from "../extensions";
import { useParagraphReorderOverlay } from "./useParagraphReorderOverlay";
import { clearBunsetsuCache } from "./bunsetsuSegmenter";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/features/project/projectStore", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/project/projectStore")>();
  return {
    ...actual,
    getCurrentProjectLanguage: () => "ja",
  };
});

function makeEditor(content: string) {
  return new Editor({
    extensions: getEditorExtensions({ setMentionPopup: vi.fn() }),
    content,
  });
}

describe("useParagraphReorderOverlay", () => {
  beforeEach(() => {
    clearBunsetsuCache();
    vi.mocked(invoke).mockReset();
  });

  it("文節 fetch 中に段落編集されたら stale として units を採用しない", async () => {
    const editor = makeEditor("<p>彼女は走った。彼は歩いた。</p>");
    editor.commands.setTextSelection(2);

    let resolveInvoke!: (v: unknown) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((r) => {
        resolveInvoke = r;
      }),
    );

    const { result } = renderHook(() =>
      useParagraphReorderOverlay(editor, false),
    );

    act(() => {
      result.current.openOverlay();
    });
    act(() => {
      result.current.setGranularity("bunsetsu");
    });

    // fetch 完了前に段落テキストを編集 (split-view 相当の外部変更をシミュレート)。
    act(() => {
      editor.commands.insertContentAt(1, "追記");
    });

    act(() => {
      resolveInvoke([
        { start: 0, end: 2, surface: "彼女" },
        { start: 2, end: 3, surface: "は" },
      ]);
    });

    await waitFor(() => {
      expect(result.current.errorMessage).toBe("staleDocument");
    });
    expect(result.current.canConfirm).toBe(false);

    editor.destroy();
  });

  it("文節 fetch 中に文へ切替したら古い async 結果で上書きしない", async () => {
    const editor = makeEditor("<p>彼女は走った。彼は歩いた。</p>");
    editor.commands.setTextSelection(2);

    let resolveInvoke!: (v: unknown) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((r) => {
        resolveInvoke = r;
      }),
    );

    const { result } = renderHook(() =>
      useParagraphReorderOverlay(editor, false),
    );

    act(() => {
      result.current.openOverlay();
    });
    // 文節へ切替 → fetch 開始（pending のまま）。
    act(() => {
      result.current.setGranularity("bunsetsu");
    });
    // fetch 完了前に文へ戻す（同期経路で sentence units が確定）。
    act(() => {
      result.current.setGranularity("sentence");
    });

    const sentenceUnits = result.current.units;
    expect(result.current.granularity).toBe("sentence");
    expect(sentenceUnits.length).toBe(2);

    // 遅れて解決した文節 fetch は最新リクエストでないため破棄される。
    act(() => {
      resolveInvoke([
        { start: 0, end: 2, surface: "彼女" },
        { start: 2, end: 3, surface: "は" },
        { start: 3, end: 6, surface: "走った" },
      ]);
    });

    await Promise.resolve();
    expect(result.current.granularity).toBe("sentence");
    expect(result.current.units).toEqual(sentenceUnits);

    editor.destroy();
  });

  it("句点なし1文でも文節粒度では units を解決できる", async () => {
    const text =
      "段落切替、段落内文、形態素解析による分節の入れ替えテストしています";
    const editor = makeEditor(`<p>${text}</p>`);
    editor.commands.setTextSelection(2);

    vi.mocked(invoke).mockResolvedValue([
      { start: 0, end: 4, surface: "段落切替" },
      { start: 4, end: 5, surface: "、" },
      { start: 5, end: 9, surface: "段落内文" },
      { start: 9, end: 10, surface: "、" },
      {
        start: 10,
        end: text.length,
        surface: "形態素解析による分節の入れ替えテストしています",
      },
    ]);

    const { result } = renderHook(() =>
      useParagraphReorderOverlay(editor, false),
    );

    act(() => {
      result.current.openOverlay();
    });
    act(() => {
      result.current.setGranularity("bunsetsu");
    });

    await waitFor(() => {
      expect(result.current.units.length).toBeGreaterThan(1);
      expect(result.current.canConfirm).toBe(true);
    });
    expect(result.current.errorMessage).toBeNull();

    editor.destroy();
  });

  it("読点区切りの文は文粒度でも units を解決できる", async () => {
    const text =
      "段落切替、段落内文、形態素解析による分節の入れ替えテストしています";
    const editor = makeEditor(`<p>${text}</p>`);
    editor.commands.setTextSelection(2);

    const { result } = renderHook(() =>
      useParagraphReorderOverlay(editor, false),
    );

    act(() => {
      result.current.openOverlay();
    });

    await waitFor(() => {
      expect(result.current.units.length).toBe(3);
      expect(result.current.canConfirm).toBe(true);
    });
    expect(result.current.errorMessage).toBeNull();

    editor.destroy();
  });
});
