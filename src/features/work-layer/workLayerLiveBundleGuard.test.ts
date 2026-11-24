import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const sourceRoot = resolve(process.cwd(), "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

function imports(source: string): string[] {
  return Array.from(
    source.matchAll(
      /\b(?:import|export)\s+(?!\s*\()[^;]*?\bfrom\s*["']([^"']+)["']/gs,
    ),
    (match) => match[1]!,
  );
}

describe("Work Layer live bundle boundaries", () => {
  const files = sourceFiles(sourceRoot).filter(
    (path) => !/\.(?:test|stories)\.[jt]sx?$/.test(path),
  );

  it("references live modules and the fixture only through dynamic imports", () => {
    const guardedModules = [
      "workLayerLivePort",
      "workLayerLiveReaders",
      "workLayerFixture",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const path of imports(source)) {
        expect(
          guardedModules.some((name) => path.includes(name)),
          `${file} statically imports ${path}`,
        ).toBe(false);
      }
    }

    const liveHook = readFileSync(
      resolve(sourceRoot, "features/editor/useWorkLayerLivePort.ts"),
      "utf8",
    );
    expect(liveHook).toContain("isWorkLayerLiveEnabled()");
    expect(liveHook).toMatch(
      /const eligible =\s*activeWorkLayer && liveEnabled && !fixturePreferred && projectId != null;/,
    );
    expect(liveHook).toMatch(
      /import\.meta\.env\.DEV && import\.meta\.env\.VITE_WORK_LAYER_FIXTURE === "true"/,
    );
    expect(liveHook).toMatch(
      /if \(!eligible \|\| projectId == null\) \{[\s\S]*?return;[\s\S]*?\}/,
    );
    const liveImportIndex = liveHook.indexOf(
      'import("@/features/work-layer/workLayerLivePort")',
    );
    const readerImportIndex = liveHook.indexOf(
      'import("./workLayerLiveReaders")',
    );
    expect(liveImportIndex).toBeGreaterThan(liveHook.indexOf("if (!eligible"));
    expect(readerImportIndex).toBeGreaterThan(
      liveHook.indexOf("if (!eligible"),
    );
    expect(liveHook).toContain("!fixturePreferred");

    const previewHook = readFileSync(
      resolve(sourceRoot, "features/work-layer/useWorkLayerPreviewPort.ts"),
      "utf8",
    );
    const fixtureGuardIndex = previewHook.indexOf(
      "!shouldEnableWorkLayerPreview",
    );
    expect(previewHook).toContain("if (import.meta.env.DEV)");
    expect(previewHook).toContain(
      "fixtureFlag: import.meta.env.VITE_WORK_LAYER_FIXTURE",
    );
    expect(fixtureGuardIndex).toBeGreaterThan(-1);
    expect(previewHook.indexOf('import("./workLayerFixture")')).toBeGreaterThan(
      fixtureGuardIndex,
    );
    const prototypePreview = readFileSync(
      resolve(sourceRoot, "features/work-layer/WorkLayerPrototypePreview.tsx"),
      "utf8",
    );
    expect(prototypePreview).toContain("if (!import.meta.env.DEV) return;");
    expect(
      prototypePreview.indexOf('import("./workLayerFixture")'),
    ).toBeGreaterThan(
      prototypePreview.indexOf("if (!import.meta.env.DEV) return;"),
    );
  });

  it("keeps feature and IPC imports outside the pure Work Layer folder", () => {
    const workLayerFiles = sourceFiles(
      resolve(sourceRoot, "features/work-layer"),
    ).filter((path) => !/\.(?:test|stories)\.[jt]sx?$/.test(path));
    const forbidden = [
      /features\/codex(?:\/|["'])/,
      /features\/narrative-extraction(?:\/|["'])/,
      /features\/project(?:\/|["'])/,
      /@\/lib\/tauri(?:["'])/,
      /@\/store(?:\/|["'])/,
    ];
    for (const file of workLayerFiles) {
      const source = readFileSync(file, "utf8");
      for (const path of imports(source)) {
        expect(
          forbidden.some((pattern) => pattern.test(path)),
          `${file} imports ${path}`,
        ).toBe(false);
      }
      expect(
        source,
        `${file} accesses the preload bridge directly`,
      ).not.toMatch(/\bwindow\s*\.\s*grimodex\b/);
    }
  });
});
