import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SCREENSHOT_CAPTURES } from "./captureManifest";

const lpSourcePath = resolve(process.cwd(), "docs/lp/lp-variant-h.jsx");
const lpAssetsDir = resolve(process.cwd(), "docs/lp/assets");
const lpSource = readFileSync(lpSourcePath, "utf8");

function lpAssetNames(captureId: string) {
  const stem = captureId.replace(/-\d+x\d+$/, "");
  return [`${stem}.png`, `${stem}-en.png`] as const;
}

describe("LP screenshot contract", () => {
  it("publishes Japanese and English assets for every screenshot capture", () => {
    const expectedAssetNames = SCREENSHOT_CAPTURES.flatMap((capture) =>
      lpAssetNames(capture.id),
    );

    for (const assetName of expectedAssetNames) {
      expect(lpSource, `${assetName} must be imported by the LP`).toContain(
        `/assets/${assetName}?`,
      );
      expect(
        existsSync(resolve(lpAssetsDir, assetName)),
        `${assetName} must exist in the LP assets directory`,
      ).toBe(true);
    }
  });

  it("keeps panel metadata, navigation, and public copy on the capture count", () => {
    const expectedPanelCount = SCREENSHOT_CAPTURES.filter(
      (capture) => capture.kind === "panel",
    ).length;
    const panelMetadataSource = lpSource.slice(
      lpSource.indexOf("const WS_PANELS = {"),
      lpSource.indexOf("const WS_ALL_PANEL_KEYS = ["),
    );
    const navigationSource = lpSource.match(
      /const WS_ALL_PANEL_KEYS = \[(?<items>[\s\S]*?)\];/,
    )?.groups?.items;

    expect(panelMetadataSource).not.toBe("");
    expect(navigationSource).toBeDefined();

    const metadataKeys = Array.from(
      panelMetadataSource.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*): \{$/gm),
      (match) => match[1],
    );
    const navigationKeys = Array.from(
      navigationSource?.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g) ?? [],
      (match) => match[1],
    );

    expect(metadataKeys).toHaveLength(expectedPanelCount);
    expect(new Set(navigationKeys)).toEqual(new Set(metadataKeys));
    expect(lpSource).toContain(`${expectedPanelCount} PANELS`);
    expect(lpSource).not.toMatch(/\b15 PANELS\b/);
  });
});
