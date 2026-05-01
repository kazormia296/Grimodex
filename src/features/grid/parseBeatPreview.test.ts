import { describe, it, expect } from "vitest";
import { parseBeatPreview } from "./parseBeatPreview";

describe("parseBeatPreview", () => {
  it("null を渡すと null を返す", () => {
    expect(parseBeatPreview(null)).toBeNull();
  });

  it("undefined を渡すと null を返す", () => {
    expect(parseBeatPreview(undefined)).toBeNull();
  });

  it("空文字列を渡すと null を返す", () => {
    expect(parseBeatPreview("")).toBeNull();
  });

  it("'[]'（空 JSON 配列）を渡すと null を返す", () => {
    expect(parseBeatPreview("[]")).toBeNull();
  });

  it("正常な JSON 配列を parse して返す", () => {
    expect(parseBeatPreview('["line1","line2","line3"]')).toEqual([
      "line1",
      "line2",
      "line3",
    ]);
  });

  it("JSON 配列の要素が string 以外を含む場合は null を返す", () => {
    expect(parseBeatPreview('[1,"two",3]')).toBeNull();
  });

  it("JSON だが配列でない場合は null を返す（オブジェクト）", () => {
    expect(parseBeatPreview('{"key":"val"}')).toBeNull();
  });

  it("旧フォーマット（改行区切り）を fallback で parse する", () => {
    expect(parseBeatPreview("line1\nline2\nline3")).toEqual([
      "line1",
      "line2",
      "line3",
    ]);
  });

  it("旧フォーマットで空行はスキップする", () => {
    expect(parseBeatPreview("A\n\nB")).toEqual(["A", "B"]);
  });

  it("JSON parse に失敗し '[' 始まりでも null を返す（壊れた JSON）", () => {
    expect(parseBeatPreview("[broken")).toBeNull();
  });

  it("例外を投げない — どんな壊れた値でも null を返す", () => {
    expect(() => parseBeatPreview('{"not":"array"}')).not.toThrow();
    expect(() => parseBeatPreview("[broken")).not.toThrow();
    expect(() => parseBeatPreview(null)).not.toThrow();
  });
});
