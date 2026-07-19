import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scanRoot = resolve(process.cwd());
const styles = readFileSync(resolve(scanRoot, "src/styles.css"), "utf8");
const mainSource = readFileSync(resolve(scanRoot, "src/main.tsx"), "utf8");
const indexHtml = readFileSync(resolve(scanRoot, "index.html"), "utf8");
const manifest = JSON.parse(
  readFileSync(resolve(scanRoot, "public/manifest.webmanifest"), "utf8"),
) as { background_color?: string; theme_color?: string };
const packageJson = JSON.parse(
  readFileSync(resolve(scanRoot, "package.json"), "utf8"),
) as { dependencies?: Record<string, string> };

function ruleBody(selector: string): string {
  const match = styles.match(
    new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`),
  );
  const declarations = match?.[1];
  expect(declarations, `${selector} ルールが見つからない`).toBeDefined();
  if (declarations === undefined) {
    throw new Error(`${selector} ルールが見つからない`);
  }
  return declarations;
}

describe("Scan light shell", () => {
  it("ブラウザとインストール表示にもライトテーマ色を宣言する", () => {
    expect(indexHtml).toContain(
      '<meta name="theme-color" content="#ffffff" />',
    );
    expect(manifest.theme_color).toBe("#ffffff");
    expect(manifest.background_color).toBe("#f7f7f7");
  });

  it("本体と同じ M PLUS 1 の表示ウェイトを同梱する", () => {
    expect(packageJson.dependencies?.["@fontsource/m-plus-1"]).toBeTruthy();
    for (const fontCss of [
      "japanese-400.css",
      "japanese-700.css",
      "latin-400.css",
      "latin-700.css",
    ]) {
      expect(mainSource).toContain(`@fontsource/m-plus-1/${fontCss}`);
    }
  });

  it("ヘッダーは既定のsolid面、ツールバーは本体カード面を使う", () => {
    const header = ruleBody("\\.scan-app-header");
    expect(header).toContain("border-bottom: 1px solid var(--border);");
    expect(header).toContain("background: var(--background);");
    expect(header).not.toContain("backdrop-filter");
    expect(header).not.toContain("box-shadow");

    const toolbar = ruleBody("\\.scan-toolbar");
    expect(toolbar).toContain("border: var(--gx-panel-border);");
    expect(toolbar).toContain("border-radius: var(--gx-panel-radius);");
    expect(toolbar).toContain("background: var(--gx-panel-bg);");
    expect(toolbar).toContain("box-shadow: var(--gx-panel-shadow);");
  });
});
