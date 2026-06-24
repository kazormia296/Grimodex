import { describe, it, expect } from "vitest";
import { computeInputHash, type InputHashPayload } from "./canonicalize";

const base: InputHashPayload = {
  promptVersion: "v1",
  model: "gpt-4o",
  effectType: "review",
  scene: "hello world",
  scope: "scene:1",
};

describe("computeInputHash — プロバイダ横断のキャッシュ分離（finding 16）", () => {
  it("provider/endpointId 未指定は従来ハッシュと byte 互換（null/undefined で不変）", async () => {
    const h0 = await computeInputHash(base);
    // null / undefined / フィールド省略はすべて同じハッシュ（既存キャッシュを壊さない）。
    expect(await computeInputHash({ ...base, provider: null })).toBe(h0);
    expect(await computeInputHash({ ...base, provider: undefined })).toBe(h0);
    expect(await computeInputHash({ ...base, endpointId: null })).toBe(h0);
    expect(await computeInputHash({ ...base, endpointId: undefined })).toBe(h0);
    expect(
      await computeInputHash({ ...base, provider: null, endpointId: null }),
    ).toBe(h0);
  });

  it("同一 model でも provider が違えば別ハッシュ（同名モデルの別プロバイダ衝突を防ぐ）", async () => {
    const openai = await computeInputHash({ ...base, provider: "openai" });
    const openrouter = await computeInputHash({
      ...base,
      provider: "openrouter",
    });
    expect(openai).not.toBe(openrouter);
    // provider 付きは「未指定（active）」とも別キー。
    expect(openai).not.toBe(await computeInputHash(base));
  });

  it("同一 provider でも endpointId が違えば別ハッシュ（互換エンドポイント間の衝突防止）", async () => {
    const a = await computeInputHash({
      ...base,
      provider: "openai-compatible",
      endpointId: "plamo",
    });
    const b = await computeInputHash({
      ...base,
      provider: "openai-compatible",
      endpointId: "lmstudio",
    });
    expect(a).not.toBe(b);
  });
});
