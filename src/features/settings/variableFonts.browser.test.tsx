import { describe, expect, it } from "vitest";

import "./fontLoaders/notoSerifJp";
import "./fontLoaders/mPlus1";
import "./fontLoaders/literata";

/**
 * 同梱の可変フォントが従来の family 名で解決され、ウェイトが連続値で効くこと
 * （'X Variable' の名前を外す vite 変換の回帰）。
 */
function measure(family: string, weight: number, text: string): number {
  const span = document.createElement("span");
  span.style.cssText = `font-family:"${family}",monospace;font-weight:${weight};font-size:40px;position:absolute;white-space:nowrap`;
  span.textContent = text;
  document.body.appendChild(span);
  const width = span.getBoundingClientRect().width;
  span.remove();
  return width;
}

describe("bundled variable fonts", () => {
  it.each([
    ["Noto Serif JP", "あいうABC"],
    ["M PLUS 1", "あいうABC"],
    ["Literata", "ABCabc"],
  ])("%s resolves and its weight axis is continuous", async (family, text) => {
    await document.fonts.load(`300 40px "${family}"`, text);
    await document.fonts.load(`800 40px "${family}"`, text);
    expect(document.fonts.check(`40px "${family}"`, text)).toBe(true);
    const light = measure(family, 300, text);
    const heavy = measure(family, 800, text);
    // 可変軸が効けば太いほど字幅が変わる（静的 400/700 では 300 と 800 が同じ face に潰れる）。
    expect(heavy).not.toBe(light);
  });
});
