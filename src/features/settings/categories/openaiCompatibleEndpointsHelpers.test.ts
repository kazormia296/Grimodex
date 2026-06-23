// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import {
  makeNewEndpoint,
  addEndpoint,
  updateEndpoint,
  removeEndpoint,
  applyEndpointsToSettings,
} from "./openaiCompatibleEndpointsHelpers";
import {
  DEFAULT_AI_SETTINGS,
  type OpenaiCompatibleEndpoint,
} from "@/features/chat/types";

const ep = (
  id: string,
  patch: Partial<OpenaiCompatibleEndpoint> = {},
): OpenaiCompatibleEndpoint => ({
  id,
  label: "",
  baseUrl: `http://localhost/${id}`,
  apiVariant: null,
  ...patch,
});

describe("openaiCompatibleEndpointsHelpers", () => {
  it("makeNewEndpoint は一意 id と空フィールドを返す", () => {
    const a = makeNewEndpoint();
    const b = makeNewEndpoint();
    expect(a.id).not.toBe(b.id);
    expect(a.label).toBe("");
    expect(a.baseUrl).toBe("");
    expect(a.apiVariant).toBeNull();
  });

  it("addEndpoint は末尾に追記し元配列を破壊しない", () => {
    const list = [ep("a")];
    const next = addEndpoint(list, ep("b"));
    expect(next.map((e) => e.id)).toEqual(["a", "b"]);
    expect(list).toHaveLength(1);
  });

  it("updateEndpoint は id 一致のみへ patch する", () => {
    const list = [ep("a"), ep("b")];
    const next = updateEndpoint(list, "b", { label: "X" });
    expect(next.find((e) => e.id === "b")?.label).toBe("X");
    expect(next.find((e) => e.id === "a")?.label).toBe("");
  });

  it("removeEndpoint: active を消すと先頭へフォールバック", () => {
    const list = [ep("a"), ep("b"), ep("c")];
    const r = removeEndpoint(list, "a", "a");
    expect(r.list.map((e) => e.id)).toEqual(["b", "c"]);
    expect(r.activeId).toBe("b");
  });

  it("removeEndpoint: 非 active を消すと active は不変", () => {
    const list = [ep("a"), ep("b")];
    const r = removeEndpoint(list, "a", "b");
    expect(r.activeId).toBe("a");
  });

  it("removeEndpoint: 最後の 1 件を消すと active は null", () => {
    const r = removeEndpoint([ep("a")], "a", "a");
    expect(r.list).toEqual([]);
    expect(r.activeId).toBeNull();
  });

  it("removeEndpoint: active が既に list 外なら先頭へ補正", () => {
    const list = [ep("a"), ep("b")];
    const r = removeEndpoint(list, "stale", "a");
    expect(r.activeId).toBe("b");
  });

  it("applyEndpointsToSettings: active を legacy openaiCompatible へミラー", () => {
    const list = [
      ep("a", { baseUrl: "http://a", customMaxContext: 4000 }),
      ep("b", {
        baseUrl: "http://b",
        customMaxContext: 8000,
        customMaxOutput: 2000,
        enableStructuredTasks: true,
      }),
    ];
    const out = applyEndpointsToSettings(DEFAULT_AI_SETTINGS, list, "b");
    expect(out.openaiCompatibleEndpoints).toBe(list);
    expect(out.activeOpenaiCompatibleEndpointId).toBe("b");
    expect(out.openaiCompatible).toEqual({
      baseUrl: "http://b",
      customMaxContext: 8000,
      customMaxOutput: 2000,
      enableStructuredTasks: true,
    });
  });

  it("applyEndpointsToSettings: activeId が不正なら先頭をミラー", () => {
    const list = [ep("a", { baseUrl: "http://a" })];
    const out = applyEndpointsToSettings(DEFAULT_AI_SETTINGS, list, "nope");
    expect(out.activeOpenaiCompatibleEndpointId).toBe("a");
    expect(out.openaiCompatible.baseUrl).toBe("http://a");
  });

  it("applyEndpointsToSettings: list 空なら legacy baseUrl を空にして温存", () => {
    const seeded = {
      ...DEFAULT_AI_SETTINGS,
      openaiCompatible: { baseUrl: "http://old", customMaxContext: 1234 },
    };
    const out = applyEndpointsToSettings(seeded, [], null);
    expect(out.openaiCompatibleEndpoints).toEqual([]);
    expect(out.activeOpenaiCompatibleEndpointId).toBeNull();
    expect(out.openaiCompatible.baseUrl).toBe("");
    // 既存のサブフィールドは温存（downgrade で baseUrl だけ消える）。
    expect(out.openaiCompatible.customMaxContext).toBe(1234);
  });
});
