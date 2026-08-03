import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(__dirname, path), "utf8");
}

describe("AI audit startup lazy-import boundaries", () => {
  it("keeps chat execution transports out of the static startup graph", () => {
    const chatApi = source("features/chat/chatApi.ts");
    const turnActions = source("application/chat/chatTurnStoreActions.ts");
    const lazyRuntimeApi = source("features/chat/lazyRuntimeApi.ts");
    const lazyTransportApi = source("features/chat/lazyTransportApi.ts");
    const runtimeImportLines = chatApi
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return (
          trimmed.startsWith("import ") && !trimmed.startsWith("import type")
        );
      })
      .join("\n");

    expect(runtimeImportLines).not.toMatch(
      /["']\.\/(singleShotTransport|chatStreamTransport)["']/u,
    );
    expect(chatApi).toContain('from "./lazyTransportApi"');
    expect(lazyTransportApi).toContain('import("./singleShotTransport")');
    expect(lazyTransportApi).toContain('import("./chatStreamTransport")');
    expect(turnActions).not.toMatch(/import \* as (cliApi|codexAppApi) from/u);
    expect(turnActions).toContain('from "@/features/chat/lazyRuntimeApi"');
    expect(lazyRuntimeApi).toContain('import("./cliApi")');
    expect(lazyRuntimeApi).toContain('import("./codexAppApi")');
  });

  it("loads editor A/B and palette UI only after their state gates open", () => {
    const overlays = source("features/editor/EditorPaneOverlays.tsx");
    const linearBlock = source("features/editor/LinearSceneBlock.tsx");

    expect(overlays).toContain('import("@/features/ab-test/AbInlineDialog")');
    expect(overlays).toContain(
      'import("@/features/editor/inlineAi/InlineAIPalette")',
    );
    expect(overlays).toMatch(/\{editor && paletteOpen && \(\s*<Suspense/u);
    expect(overlays).toMatch(/\{abInline && \(\s*<Suspense/u);
    expect(linearBlock).toContain(
      'import("@/features/editor/inlineAi/InlineAIPalette")',
    );
    expect(linearBlock).toMatch(
      /\{editor && inlineAi\.paletteOpen && \(\s*<Suspense/u,
    );
  });

  it("keeps mode and dialog bundles behind their existing user-state gates", () => {
    const sceneEditor = source("features/tree/SceneEditor.tsx");
    const scenesPanel = source("features/tree/ScenesPanel.tsx");

    expect(sceneEditor).toContain(
      'import("@/features/editor/LinearEditorView")',
    );
    expect(sceneEditor).toContain(
      'import("@/features/revision/RevisionHistoryModal")',
    );
    expect(sceneEditor).toMatch(/if \(isLinearMode && !phoneProjection\)/u);
    expect(sceneEditor.match(/\{revisionHistoryOpen && \(/gu)).toHaveLength(2);

    expect(scenesPanel).toContain('import("./aiScaffold/AiTreeDialog")');
    expect(scenesPanel).toContain(
      'import("@/features/labels/ManageLabelsDialog")',
    );
    expect(scenesPanel).toMatch(/\{aiTree && \(\s*<Suspense/u);
    expect(scenesPanel).toMatch(/onClose=\{\(\) => setAiTree\(null\)\}/u);
    expect(scenesPanel).toMatch(/\{manageLabelsOpen && \(\s*<Suspense/u);
    expect(scenesPanel).toMatch(
      /onClose=\{\(\) => setManageLabelsOpen\(false\)\}/u,
    );
  });

  it("loads the audit ZIP assembler only inside the click-owned frozen-read callback", () => {
    const attributionView = source(
      "features/attribution/AttributionProjectView.tsx",
    );
    const runtimeImportLines = attributionView
      .split("\n")
      .filter((line) => {
        const trimmed = line.trimStart();
        return (
          trimmed.startsWith("import ") && !trimmed.startsWith("import type")
        );
      })
      .join("\n");
    const handlerStart = attributionView.indexOf(
      "const handleAiAuditExport = useCallback",
    );
    const handlerEnd = attributionView.indexOf(
      "const chapters =",
      handlerStart,
    );
    const handler = attributionView.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(runtimeImportLines).not.toMatch(
      /["']@\/features\/ai-audit\/exportBundle["']/u,
    );
    expect(handler).toMatch(
      /runAiAuditExportBoundary\([\s\S]*await import\(\s*["']@\/features\/ai-audit\/exportBundle["']\s*\)/u,
    );
  });
});
