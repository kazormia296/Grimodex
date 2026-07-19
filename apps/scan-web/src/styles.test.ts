import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const scanStyles = readFileSync(
  resolve(process.cwd(), "src/styles.css"),
  "utf8",
);
const appStyles = readFileSync(
  resolve(process.cwd(), "../../src/index.css"),
  "utf8",
);

function rootDeclarations(css: string): string {
  const match = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  const declarations = match?.[1];
  expect(declarations, "CSS に :root が見つからない").toBeDefined();
  if (declarations === undefined) {
    throw new Error("CSS に :root が見つからない");
  }
  return declarations;
}

function variableValue(declarations: string, name: string): string {
  const match = declarations.match(new RegExp(`${name}:\\s*([^;]+);`));
  const value = match?.[1];
  expect(value, `${name} が :root に見つからない`).toBeDefined();
  if (value === undefined) {
    throw new Error(`${name} が :root に見つからない`);
  }
  return value.replace(/\s+/g, " ").trim();
}

describe("Scan default light theme", () => {
  it("本体の既定 Simple ライトテーマと意味色を共有する", () => {
    const scanRoot = rootDeclarations(scanStyles);
    const appRoot = rootDeclarations(appStyles);
    const sharedTokens = [
      "--background",
      "--foreground",
      "--card",
      "--card-foreground",
      "--primary",
      "--primary-foreground",
      "--secondary",
      "--secondary-foreground",
      "--muted",
      "--muted-foreground",
      "--accent",
      "--accent-foreground",
      "--destructive",
      "--destructive-foreground",
      "--border",
      "--input",
      "--ring",
      "--radius",
    ] as const;

    for (const token of sharedTokens) {
      expect(variableValue(scanRoot, token), token).toBe(
        variableValue(appRoot, token),
      );
    }
  });

  it("本体のキャンバスとカード表現を共有する", () => {
    const scanRoot = rootDeclarations(scanStyles);
    const appRoot = rootDeclarations(appStyles);
    const sharedTokens = [
      "--gx-panel-radius",
      "--gx-panel-bg-top",
      "--gx-panel-bg-mid",
      "--gx-panel-bg-bottom",
      "--gx-panel-bg",
      "--gx-panel-rim",
      "--gx-panel-border",
      "--gx-canvas-bg",
      "--gx-panel-shadow",
    ] as const;

    for (const token of sharedTokens) {
      expect(variableValue(scanRoot, token), token).toBe(
        variableValue(appRoot, token),
      );
    }

    expect(scanStyles).toMatch(
      /body\s*\{[\s\S]*?background:\s*var\(--gx-canvas-bg\);/,
    );
    expect(scanStyles).toMatch(
      /\.scan-card\s*\{[\s\S]*?border:\s*var\(--gx-panel-border\);[\s\S]*?background:\s*var\(--gx-panel-bg\);[\s\S]*?box-shadow:\s*var\(--gx-panel-shadow\);/,
    );
  });

  it("OS設定に関係なくライトテーマを保ち、旧紫テーマを残さない", () => {
    expect(scanStyles).toContain("color-scheme: light;");
    expect(scanStyles).not.toContain("@media (prefers-color-scheme: dark)");
    expect(scanStyles.toLowerCase()).not.toContain("#534ab7");
    expect(scanStyles.toLowerCase()).not.toContain("#eeecf6");
  });
});
