import { describe, it, expect } from "vitest";
import {
  getOpenaiCompatibleEndpoints,
  resolveActiveOpenaiCompatibleEndpoint,
  LEGACY_OPENAI_COMPAT_ENDPOINT_ID,
} from "./types";

describe("getOpenaiCompatibleEndpoints (FE migration)", () => {
  it("配列があればそれを返す", () => {
    const list = getOpenaiCompatibleEndpoints({
      openaiCompatible: { baseUrl: "http://legacy/v1" },
      openaiCompatibleEndpoints: [
        { id: "a", label: "A", baseUrl: "http://a/v1" },
      ],
    });
    expect(list.map((e) => e.id)).toEqual(["a"]);
  });

  it("配列が空なら legacy baseUrl から default を合成する", () => {
    const list = getOpenaiCompatibleEndpoints({
      openaiCompatible: {
        baseUrl: "http://legacy/v1",
        customMaxContext: 32000,
        enableStructuredTasks: true,
      },
      openaiCompatibleEndpoints: [],
    });
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(LEGACY_OPENAI_COMPAT_ENDPOINT_ID);
    expect(list[0].baseUrl).toBe("http://legacy/v1");
    expect(list[0].customMaxContext).toBe(32000);
    expect(list[0].enableStructuredTasks).toBe(true);
  });

  it("legacy も空なら空配列", () => {
    expect(
      getOpenaiCompatibleEndpoints({
        openaiCompatible: { baseUrl: "" },
        openaiCompatibleEndpoints: [],
      }),
    ).toEqual([]);
    // 空白のみも空扱い。
    expect(
      getOpenaiCompatibleEndpoints({
        openaiCompatible: { baseUrl: "   " },
      }),
    ).toEqual([]);
  });
});

describe("resolveActiveOpenaiCompatibleEndpoint", () => {
  const settings = {
    openaiCompatible: { baseUrl: "" },
    openaiCompatibleEndpoints: [
      { id: "a", label: "A", baseUrl: "http://a/v1" },
      { id: "b", label: "B", baseUrl: "http://b/v1" },
    ],
    activeOpenaiCompatibleEndpointId: "b",
  };

  it("requestedId が最優先", () => {
    expect(resolveActiveOpenaiCompatibleEndpoint(settings, "a")?.id).toBe("a");
  });

  it("requestedId 無しなら active id", () => {
    expect(resolveActiveOpenaiCompatibleEndpoint(settings)?.id).toBe("b");
  });

  it("不正な id は先頭にフォールバック", () => {
    expect(resolveActiveOpenaiCompatibleEndpoint(settings, "zzz")?.id).toBe(
      "a",
    );
    expect(
      resolveActiveOpenaiCompatibleEndpoint({
        ...settings,
        activeOpenaiCompatibleEndpointId: "missing",
      })?.id,
    ).toBe("a");
  });

  it("legacy 単一設定も解決できる", () => {
    expect(
      resolveActiveOpenaiCompatibleEndpoint({
        openaiCompatible: { baseUrl: "http://legacy/v1" },
        openaiCompatibleEndpoints: [],
        activeOpenaiCompatibleEndpointId: null,
      })?.baseUrl,
    ).toBe("http://legacy/v1");
  });

  it("エンドポイントが無ければ undefined", () => {
    expect(
      resolveActiveOpenaiCompatibleEndpoint({
        openaiCompatible: { baseUrl: "" },
        openaiCompatibleEndpoints: [],
      }),
    ).toBeUndefined();
  });
});
