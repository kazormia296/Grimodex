import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(__dirname, "App.tsx"), "utf8");
const applicationDialogsSource = readFileSync(
  resolve(__dirname, "components/ApplicationDialogs.tsx"),
  "utf8",
);

describe("App lazy import boundaries", () => {
  it("delegates the conditional dialogs from the application root", () => {
    expect(appSource).toMatch(/<ApplicationDialogs\b/u);
  });

  it("does not statically import dormant application dialogs", () => {
    expect(applicationDialogsSource).not.toMatch(
      /import\s+(?!\()[^;]*"@\/(?:lib\/DebugLogViewer|features\/release-notes\/ReleaseNotesDialog|features\/workspace\/WorkspaceTrustDialog)"\s*;/u,
    );
  });

  it("mounts the Web Editor handoff importer only while it is open", () => {
    expect(
      applicationDialogsSource.match(/<WebEditorWorkspaceImportDialog\b/gu),
    ).toHaveLength(1);
    expect(applicationDialogsSource).toMatch(
      /\{runtimeCapabilities\.genericProjectTransfer\s*&&\s*showWebEditorImport\s*&&\s*\(\s*<Suspense fallback=\{null\}>\s*<WebEditorWorkspaceImportDialog\s+open\s+/u,
    );
  });

  it("keeps the hidden debug log viewer outside the startup graph", () => {
    expect(applicationDialogsSource).toMatch(
      /const DebugLogViewer = lazy\(\(\) =>\s*import\("@\/lib\/DebugLogViewer"\)/u,
    );
    expect(applicationDialogsSource).toMatch(
      /\{debugLogOpen && \(\s*<Suspense fallback=\{null\}>\s*<DebugLogViewer \/>/u,
    );
  });

  it("loads release notes only after the gate opens them", () => {
    expect(applicationDialogsSource).toMatch(
      /const ReleaseNotesDialog = lazy\(\(\) =>\s*import\("@\/features\/release-notes\/ReleaseNotesDialog"\)/u,
    );
    expect(applicationDialogsSource).toMatch(
      /\{releaseNotesOpen && \(\s*<Suspense fallback=\{null\}>\s*<ReleaseNotesDialog \/>/u,
    );
  });

  it("loads the Workspace trust prompt only for a pending path", () => {
    expect(applicationDialogsSource).toMatch(
      /const WorkspaceTrustDialog = lazy\(\(\) =>\s*import\("@\/features\/workspace\/WorkspaceTrustDialog"\)/u,
    );
    expect(applicationDialogsSource).toMatch(
      /\{pendingTrustPath && \(\s*<Suspense fallback=\{null\}>\s*<WorkspaceTrustDialog \/>/u,
    );
  });
});
