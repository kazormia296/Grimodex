import { describe, it, expect } from "vitest";
import { parseWindowMode, CODEX_WINDOW_LABEL } from "./codexWindowMode";

describe("parseWindowMode", () => {
  it("?window=codex → 'codex'", () => {
    expect(parseWindowMode("?window=codex")).toBe("codex");
  });

  it("クエリ無し → 'main'", () => {
    expect(parseWindowMode("")).toBe("main");
    expect(parseWindowMode("?")).toBe("main");
  });

  it("別の window 値 → 'main'", () => {
    expect(parseWindowMode("?window=foo")).toBe("main");
  });

  it("他のパラメータが混在しても判定できる", () => {
    expect(parseWindowMode("?foo=1&window=codex&bar=2")).toBe("codex");
  });

  it("先頭の ? 無しでも解釈する", () => {
    expect(parseWindowMode("window=codex")).toBe("codex");
  });
});

describe("CODEX_WINDOW_LABEL", () => {
  it("capability の windows scope と一致する label 定数", () => {
    expect(CODEX_WINDOW_LABEL).toBe("codex-window");
  });
});
