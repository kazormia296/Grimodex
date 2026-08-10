import { describe, it, expect } from "vitest";
import {
  digestImportSourcePackage,
  sealImportSourcePackage,
  type ImportSourcePackageDraft,
} from "./importSourcePackage";
import { IMPORT_SOURCE_PACKAGE_SCHEMA_VERSION } from "./importSourcePackage";

function baseDraft(createdAt: string): ImportSourcePackageDraft {
  return {
    schemaVersion: IMPORT_SOURCE_PACKAGE_SCHEMA_VERSION,
    identity: {
      sourceSetId: "test:set",
      fingerprint: "fp-1",
      hints: { adapterId: "markdown", adapterVersion: "1" },
    },
    manifest: { entries: [{ kind: "plain-text", label: "sample.md" }] },
    nodes: [
      {
        key: "scene-1",
        parentKey: null,
        title: "Scene",
        orderIndex: 0,
        kind: "scene",
      },
    ],
    documents: [
      {
        key: "doc:scene-1",
        nodeKey: "scene-1",
        title: "Scene",
        orderIndex: 0,
        proseMirrorJson: '{"type":"doc","content":[]}',
        plainText: "hello",
      },
    ],
    structure: { codexEntries: [], snippets: [] },
    diagnostics: [],
    createdAt,
  };
}

describe("import source package digest", () => {
  it("ignores createdAt when computing digest", async () => {
    const a = await digestImportSourcePackage(baseDraft("2026-01-01T00:00:00.000Z"));
    const b = await digestImportSourcePackage(baseDraft("2026-02-01T00:00:00.000Z"));
    expect(a).toBe(b);
  });

  it("seal attaches digest stable across createdAt changes", async () => {
    const draftA = baseDraft("2026-01-01T00:00:00.000Z");
    const draftB = baseDraft("2026-03-01T00:00:00.000Z");
    const sealedA = await sealImportSourcePackage(draftA);
    const sealedB = await sealImportSourcePackage(draftB);
    expect(sealedA.digest).toBe(sealedB.digest);
    expect(sealedA.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
