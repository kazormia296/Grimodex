import { describe, expect, it } from "vitest";

import { loadBundledFontForCssValue } from "./bundledFontLoader";

/**
 * 同梱の日本語可変フォントは約 120 の unicode-range slice に分かれる。slice の取得が
 * 終わるたびに Chromium は本文全体を再 layout するので、長い本文を開いたあとに未取得の字を
 * 打つと自動保存の long task 予算 (90 ms) を超える。CSS を読み込んだら全 slice を先に
 * 取得しておくこと（と、それで太さの見た目が変わらないこと）を実 Chromium で確かめる。
 */
const FAMILY = "Noto Serif JP";

function faces(family: string): FontFace[] {
  const found: FontFace[] = [];
  document.fonts.forEach((face) => {
    if (face.family.replace(/^["']|["']$/g, "") === family) found.push(face);
  });
  return found;
}

function measure(weight: number, text: string): number {
  const span = document.createElement("span");
  span.style.cssText = `font-family:"${FAMILY}",monospace;font-weight:${weight};font-size:40px;position:absolute;white-space:nowrap`;
  span.textContent = text;
  document.body.appendChild(span);
  const width = span.getBoundingClientRect().width;
  span.remove();
  return width;
}

async function until(condition: () => boolean, timeoutMs = 15_000) {
  const start = performance.now();
  while (!condition()) {
    if (performance.now() - start > timeoutMs) {
      throw new Error("timed out waiting for the font slices");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("bundled Japanese font slice prefetch", () => {
  it("fetches every slice after the CSS loads, so typing a new kanji starts no download", async () => {
    await loadBundledFontForCssValue(`"${FAMILY}", serif`);
    // 先読みは CSS の import の後ろで非同期に走る。
    await until(() => {
      const all = faces(FAMILY);
      return all.length > 100 && all.every((face) => face.status === "loaded");
    });

    let started = 0;
    const onStart = () => {
      started += 1;
    };
    document.fonts.addEventListener("loadingstart", onStart);
    try {
      // 先読みが無ければ、どれも別々の slice で、打つたびに取得が始まる。
      const editor = document.createElement("div");
      editor.style.cssText = `font-family:"${FAMILY}",serif;font-size:20px`;
      editor.textContent = "性能回帰入力定常保存帰力鬱薔薇";
      document.body.appendChild(editor);
      editor.getBoundingClientRect();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 300));
      editor.remove();
    } finally {
      document.fonts.removeEventListener("loadingstart", onStart);
    }
    expect(started).toBe(0);
  });

  it("keeps the weight axis working after the prefetch", async () => {
    await loadBundledFontForCssValue(`"${FAMILY}", serif`);
    await until(() => faces(FAMILY).every((face) => face.status === "loaded"));
    const light = measure(300, "性能回帰ABC");
    const heavy = measure(800, "性能回帰ABC");
    expect(heavy).not.toBe(light);
  });
});
