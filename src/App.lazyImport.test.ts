import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(__dirname, "App.tsx"), "utf8");

describe("App lazy import boundaries", () => {
  it("mounts the Web Editor handoff importer only while it is open", () => {
    expect(appSource.match(/<WebEditorWorkspaceImportDialog\b/gu)).toHaveLength(
      1,
    );
    expect(appSource).toMatch(
      /\{runtimeCapabilities\.genericProjectTransfer\s*&&\s*showWebEditorImport\s*&&\s*\(\s*<Suspense fallback=\{null\}>\s*<WebEditorWorkspaceImportDialog\s+open\s+/u,
    );
  });

  it("keeps the hidden debug log viewer outside the startup graph", () => {
    expect(appSource).toMatch(
      /const DebugLogViewer = lazy\(\(\) =>\s*import\("@\/lib\/DebugLogViewer"\)/u,
    );
    expect(appSource).toMatch(
      /\{debugLogOpen && \(\s*<Suspense fallback=\{null\}>\s*<DebugLogViewer \/>/u,
    );
  });

  it("loads release notes only after the gate opens them", () => {
    expect(appSource).toMatch(
      /const ReleaseNotesDialog = lazy\(\(\) =>\s*import\("@\/features\/release-notes\/ReleaseNotesDialog"\)/u,
    );
    expect(appSource).toMatch(
      /\{releaseNotesOpen && \(\s*<Suspense fallback=\{null\}>\s*<ReleaseNotesDialog \/>/u,
    );
  });

  it("loads the Workspace trust prompt only for a pending path", () => {
    expect(appSource).toMatch(
      /const WorkspaceTrustDialog = lazy\(\(\) =>\s*import\("@\/features\/workspace\/WorkspaceTrustDialog"\)/u,
    );
    expect(appSource).toMatch(
      /\{pendingTrustPath && \(\s*<Suspense fallback=\{null\}>\s*<WorkspaceTrustDialog \/>/u,
    );
  });
});
