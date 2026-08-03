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
});
