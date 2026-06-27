import { describe, expect, it } from "vitest";
import ja from "@/locales/ja.json";
import en from "@/locales/en.json";
import { KNOWN_SURFACES, surfaceLabel } from "./usageLabels";

/**
 * AI usage サーフェスの網羅性ゲート。
 * KNOWN_SURFACES の各サーフェスが ja/en 両ロケールに
 * settings.usage.surface.<surface> のラベルを持つこと、かつ
 * surfaceLabel がキーをそのまま返す fallback に落ちていないことを保証する。
 * 新サーフェスを足してラベルを忘れるとここで落ちる。
 */
describe("usageLabels surface 網羅性", () => {
  const jaSurface = (
    ja as { settings: { usage: { surface: Record<string, string> } } }
  ).settings.usage.surface;
  const enSurface = (
    en as { settings: { usage: { surface: Record<string, string> } } }
  ).settings.usage.surface;

  it("KNOWN_SURFACES は空でない", () => {
    expect(KNOWN_SURFACES.length).toBeGreaterThan(0);
  });

  for (const surface of KNOWN_SURFACES) {
    it(`${surface}: ja.json に settings.usage.surface.${surface} がある`, () => {
      expect(typeof jaSurface[surface]).toBe("string");
      expect(jaSurface[surface]).not.toBe("");
    });

    it(`${surface}: en.json に settings.usage.surface.${surface} がある`, () => {
      expect(typeof enSurface[surface]).toBe("string");
      expect(enSurface[surface]).not.toBe("");
    });

    it(`${surface}: surfaceLabel が raw key fallback に落ちない`, () => {
      expect(surfaceLabel(surface)).not.toBe(surface);
    });
  }
});
