// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handleCopyWithAttribution,
  parseClipboardHtml,
} from "./clipboardAttribution";

type CopyEvent = Parameters<typeof handleCopyWithAttribution>[0];

function makeClipboardEvent() {
  const data: Record<string, string> = {};
  const preventDefault = vi.fn();
  const event = {
    preventDefault,
    clipboardData: {
      setData: (type: string, value: string) => {
        data[type] = value;
      },
      getData: (type: string) => data[type] ?? "",
    },
  } as unknown as CopyEvent;
  return { event, data, preventDefault };
}

function stubSelection(text: string) {
  vi.spyOn(window, "getSelection").mockReturnValue({
    toString: () => text,
  } as unknown as Selection);
}

afterEach(() => vi.restoreAllMocks());

// handleCopyWithAttribution (producer) ↔ parseClipboardHtml (consumer) の契約。
// Sticky の onCopy はこの producer を呼ぶので、ここが緑なら paste 側
// (EditorPane handlePaste Case 1 → insertFromPaste) で source が正しく適用される。
describe("handleCopyWithAttribution → parseClipboardHtml round-trip", () => {
  it("AI 選択をコピーすると text/html に data-grimodex-source='ai' が載り、parse で全 segment が ai になる", () => {
    stubSelection("AI が書いた本文");
    const { event, data, preventDefault } = makeClipboardEvent();

    handleCopyWithAttribution(event, "ai");

    expect(preventDefault).toHaveBeenCalled();
    expect(data["text/plain"]).toBe("AI が書いた本文");
    expect(data["text/html"]).toContain('data-grimodex-source="ai"');

    const segments = parseClipboardHtml(data["text/html"]);
    expect(segments).not.toBeNull();
    expect(segments!.every((s) => s.source === "ai")).toBe(true);
    expect(segments!.map((s) => s.text).join("")).toBe("AI が書いた本文");
  });

  it("複数段落 (改行入り) でも source='ai' が全テキストに伝搬する", () => {
    stubSelection("一段落目\n二段落目");
    const { event, data } = makeClipboardEvent();

    handleCopyWithAttribution(event, "ai");
    const segments = parseClipboardHtml(data["text/html"]);

    expect(segments).not.toBeNull();
    expect(segments!.every((s) => s.source === "ai")).toBe(true);
    // 改行は segment text 内に保持され、insertFromPaste 側で段落分割される。
    expect(segments!.map((s) => s.text).join("")).toBe("一段落目\n二段落目");
  });

  it("human 選択では source='human' が載る", () => {
    stubSelection("人間が書いた");
    const { event, data } = makeClipboardEvent();

    handleCopyWithAttribution(event, "human");
    expect(data["text/html"]).toContain('data-grimodex-source="human"');
    const segments = parseClipboardHtml(data["text/html"]);
    expect(segments!.every((s) => s.source === "human")).toBe(true);
  });

  it("HTML 特殊文字を含む選択はエスケープされ、parse 後も元テキストに戻る", () => {
    stubSelection('<script>alert("x")</script> & 続き');
    const { event, data } = makeClipboardEvent();

    handleCopyWithAttribution(event, "ai");
    // 生 HTML が混入していない (エスケープされている) こと。
    expect(data["text/html"]).not.toContain("<script>");
    const segments = parseClipboardHtml(data["text/html"]);
    expect(segments!.map((s) => s.text).join("")).toBe(
      '<script>alert("x")</script> & 続き',
    );
    expect(segments!.every((s) => s.source === "ai")).toBe(true);
  });

  it("選択が空のときは clipboard に何も書かず preventDefault も呼ばない", () => {
    stubSelection("");
    const { event, data, preventDefault } = makeClipboardEvent();

    handleCopyWithAttribution(event, "ai");
    expect(preventDefault).not.toHaveBeenCalled();
    expect(Object.keys(data)).toHaveLength(0);
  });
});
