// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  clearBunsetsuCache,
  fetchBunsetsuUnits,
  getCachedBunsetsuUnits,
  prefetchBunsetsuUnits,
} from "./bunsetsuSegmenter";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { captureSwapSnapshot } from "./paragraphSnapshot";
import { resolveParagraphAtSelection } from "./paragraphFlat";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("bunsetsuSegmenter", () => {
  beforeEach(() => {
    clearBunsetsuCache();
    vi.mocked(invoke).mockReset();
  });

  it("invoke 成功で units を返し cache する", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { start: 0, end: 2, surface: "彼女" },
      { start: 2, end: 3, surface: "は" },
    ]);
    const units = await fetchBunsetsuUnits("彼女は");
    expect(units).toHaveLength(2);
    expect(invoke).toHaveBeenCalledTimes(1);
    const again = await fetchBunsetsuUnits("彼女は");
    expect(again).toEqual(units);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("in-flight promise を reuse する", async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const p1 = fetchBunsetsuUnits("テスト");
    const p2 = fetchBunsetsuUnits("テスト");
    resolve([{ start: 0, end: 3, surface: "テスト" }]);
    const [u1, u2] = await Promise.all([p1, p2]);
    expect(u1).toEqual(u2);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("getCachedBunsetsuUnits は state なしで null", () => {
    expect(getCachedBunsetsuUnits(null, "ja")).toBeNull();
  });

  it("getCachedBunsetsuUnits は in-flight 中 (units=[]) を miss として扱う", async () => {
    let resolve!: (v: unknown) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>彼女は走る。</p>",
    });
    editor.commands.setTextSelection(2);
    const fetchPromise = fetchBunsetsuUnits("彼女は走る。");
    // in-flight 中は units:[] が cache されているが、[] は「確定した空 unit 集合」
    // ではなく「未解決」なので miss (null) を返すべき。
    expect(getCachedBunsetsuUnits(editor.state, "ja")).toBeNull();
    resolve([{ start: 0, end: 2, surface: "彼女" }]);
    await fetchPromise;
    editor.destroy();
  });

  it("prefetch 失敗時に onFailed を呼ぶ", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("ipc fail"));
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>彼女は走る。</p>",
    });
    editor.commands.setTextSelection(2);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const snap = captureSwapSnapshot(editor.state, resolved, 1);
    const onFailed = vi.fn();
    prefetchBunsetsuUnits(editor, snap, "ja", vi.fn(), onFailed);
    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledWith(snap));
    editor.destroy();
  });

  it("prefetch 完了後に選択が変わっていたら onReady を呼ばない", async () => {
    vi.mocked(invoke).mockResolvedValue([
      { start: 0, end: 2, surface: "彼女" },
      { start: 2, end: 3, surface: "は" },
    ]);
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>彼女は走る。</p>",
    });
    editor.commands.setTextSelection(2);
    const resolved = resolveParagraphAtSelection(editor.state)!;
    const snap = captureSwapSnapshot(editor.state, resolved, 1);
    const onReady = vi.fn();
    prefetchBunsetsuUnits(editor, snap, "ja", onReady);
    editor.commands.setTextSelection(4);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(onReady).not.toHaveBeenCalled();
    editor.destroy();
  });
});
