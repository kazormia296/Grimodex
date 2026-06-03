import { describe, it, expect } from "vitest";
import { resolveTreeDropZone } from "./treeDropZone";

// over 矩形: top=100, height=40 → 0.25h=10, 0.75h=30, h/2=20
const rect = { top: 100, height: 40 };

describe("resolveTreeDropZone", () => {
  describe("container (folder): 上25% before / 中央50% inside / 下25% after", () => {
    it("上 25% 未満は before", () => {
      expect(resolveTreeDropZone(100 + 9, rect, true)).toBe("before");
    });
    it("25% ちょうど(relY=10)は inside（< は厳密）", () => {
      expect(resolveTreeDropZone(100 + 10, rect, true)).toBe("inside");
    });
    it("中央は inside", () => {
      expect(resolveTreeDropZone(100 + 20, rect, true)).toBe("inside");
    });
    it("75% ちょうど(relY=30)は inside（> は厳密）", () => {
      expect(resolveTreeDropZone(100 + 30, rect, true)).toBe("inside");
    });
    it("下 25% 超は after", () => {
      expect(resolveTreeDropZone(100 + 31, rect, true)).toBe("after");
    });
  });

  describe("leaf (scene): 中点で before/after の 2 分割", () => {
    it("上半分は before", () => {
      expect(resolveTreeDropZone(100 + 19, rect, false)).toBe("before");
    });
    it("中点(relY=20)は after（< h/2 は厳密）", () => {
      expect(resolveTreeDropZone(100 + 20, rect, false)).toBe("after");
    });
  });
});
