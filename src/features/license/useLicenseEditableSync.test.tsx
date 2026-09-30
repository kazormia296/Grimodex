// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Editor } from "@tiptap/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useLicenseStore } from "./store";
import { useLicenseEditableSync } from "./useLicenseEditableSync";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import {
  _resetDocumentSaveCoordinatorForTests,
  runExclusiveDocumentMutation,
} from "@/features/editor/document/documentSaveCoordinator";
import {
  acquireTimelapseReplacementFence,
  isTimelapseReplacementFenceActiveForDocument,
} from "@/features/timelapse/documentCoverage";
import { publishCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";

describe("useLicenseEditableSync lifecycle barrier", () => {
  beforeEach(() => {
    _resetQuiescenceLeasesForTests();
    _resetDocumentSaveCoordinatorForTests();
    useLicenseStore.setState({
      licensingEnabled: false,
      status: "disabled",
      staleConfirmed: false,
    });
  });

  afterEach(() => {
    _resetQuiescenceLeasesForTests();
    _resetDocumentSaveCoordinatorForTests();
    publishCurrentProjectId(null);
    setCurrentWorkspaceIdentity(null);
  });

  it("makes every participating TipTap surface read-only until the last lease releases", () => {
    const setEditable = vi.fn();
    const editor = {
      isDestroyed: false,
      setEditable,
    } as unknown as Editor;
    renderHook(() => useLicenseEditableSync(editor));

    expect(setEditable).toHaveBeenLastCalledWith(true, false);

    let projectLease!: ReturnType<typeof acquireQuiescenceLease>;
    let workspaceLease!: ReturnType<typeof acquireQuiescenceLease>;
    act(() => {
      projectLease = acquireQuiescenceLease("project-load");
      workspaceLease = acquireQuiescenceLease("workspace-open");
    });
    expect(setEditable).toHaveBeenLastCalledWith(false, false);

    act(() => projectLease.release());
    expect(setEditable).toHaveBeenLastCalledWith(false, false);

    act(() => workspaceLease.release());
    expect(setEditable).toHaveBeenLastCalledWith(true, false);
  });

  it("keeps an unloaded editor read-only and restores editing only after load succeeds", () => {
    const setEditable = vi.fn();
    const editor = {
      isDestroyed: false,
      setEditable,
    } as unknown as Editor;
    const { rerender } = renderHook(
      ({ loaded }) => useLicenseEditableSync(editor, !loaded),
      { initialProps: { loaded: false } },
    );

    expect(setEditable).toHaveBeenLastCalledWith(false, false);

    rerender({ loaded: true });

    expect(setEditable).toHaveBeenLastCalledWith(true, false);
  });

  it("synchronously blocks only the document under exclusive replacement", async () => {
    const key = {
      kind: "tree",
      id: "scene-1",
      storage: "file",
    } as const;
    const setEditable = vi.fn();
    const editor = {
      isDestroyed: false,
      setEditable,
    } as unknown as Editor;
    renderHook(() => useLicenseEditableSync(editor, false, key));

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let replacement!: Promise<void>;
    act(() => {
      replacement = runExclusiveDocumentMutation(key, () => gate);
    });
    expect(setEditable).toHaveBeenLastCalledWith(false, false);

    await act(async () => {
      release();
      await replacement;
    });
    expect(setEditable).toHaveBeenLastCalledWith(true, false);
  });

  it.each([
    [
      "tree database",
      { kind: "tree", id: "scene-db", storage: "database" } as const,
      {
        projectId: "project-fence",
        domain: "editor",
        entityType: "scene",
        entityId: "scene-db",
        storage: "database",
      } as const,
    ],
    [
      "tree file",
      { kind: "tree", id: "scene-file", storage: "file" } as const,
      {
        projectId: "project-fence",
        domain: "editor",
        entityType: "scene",
        entityId: "scene-file",
        storage: "file",
      } as const,
    ],
    [
      "codex base",
      { kind: "codex", id: "codex-1", phaseId: null } as const,
      {
        projectId: "project-fence",
        domain: "codex",
        entityType: "codex_entry",
        entityId: "codex-1",
      } as const,
    ],
    [
      "snippet",
      { kind: "snippet", id: "snippet-1" } as const,
      {
        projectId: "project-fence",
        domain: "snippet",
        entityType: "snippet",
        entityId: "snippet-1",
      } as const,
    ],
  ])(
    "synchronously denies the exact loaded %s document",
    (_label, key, identity) => {
      publishCurrentProjectId("project-fence");
      setCurrentWorkspaceIdentity({ path: "/fence.gdx", openRevision: 1 });
      const setEditable = vi.fn();
      const editor = {
        isDestroyed: false,
        setEditable,
      } as unknown as Editor;
      renderHook(() =>
        useLicenseEditableSync(editor, false, key, "project-fence"),
      );

      let fence!: ReturnType<typeof acquireTimelapseReplacementFence>;
      act(() => {
        fence = acquireTimelapseReplacementFence({
          projectId: "project-fence",
          document: identity,
        });
      });
      expect(setEditable).toHaveBeenLastCalledWith(false, false);

      act(() => fence.release());
      expect(setEditable).toHaveBeenLastCalledWith(true, false);
    },
  );

  it.each([
    [
      "different document",
      "project-fence",
      {
        projectId: "project-fence",
        domain: "editor",
        entityType: "scene",
        entityId: "scene-other",
        storage: "database",
      } as const,
    ],
    [
      "different scene storage",
      "project-fence",
      {
        projectId: "project-fence",
        domain: "editor",
        entityType: "scene",
        entityId: "scene-db",
        storage: "file",
      } as const,
    ],
  ])(
    "does not deny the loaded document for a %s fence",
    (_label, projectId, identity) => {
      publishCurrentProjectId("project-fence");
      setCurrentWorkspaceIdentity({ path: "/fence.gdx", openRevision: 1 });
      const setEditable = vi.fn();
      const editor = {
        isDestroyed: false,
        setEditable,
      } as unknown as Editor;
      const key = {
        kind: "tree",
        id: "scene-db",
        storage: "database",
      } as const;
      renderHook(() =>
        useLicenseEditableSync(editor, false, key, "project-fence"),
      );

      let fence!: ReturnType<typeof acquireTimelapseReplacementFence>;
      act(() => {
        fence = acquireTimelapseReplacementFence({
          projectId,
          document: identity,
        });
      });
      expect(setEditable).toHaveBeenLastCalledWith(true, false);
      act(() => fence.release());
    },
  );

  it("keeps the direct timelapse fence query project-scoped", () => {
    const key = {
      kind: "tree",
      id: "scene-db",
      storage: "database",
    } as const;
    const fence = acquireTimelapseReplacementFence({
      projectId: "other-project",
      document: {
        projectId: "other-project",
        domain: "editor",
        entityType: "scene",
        entityId: "scene-db",
        storage: "database",
      },
    });
    expect(
      isTimelapseReplacementFenceActiveForDocument("project-fence", key),
    ).toBe(false);
    expect(
      isTimelapseReplacementFenceActiveForDocument("other-project", key),
    ).toBe(true);
    fence.release();
  });

  it("denies every loaded document for a project-wide replacement fence", () => {
    publishCurrentProjectId("project-fence");
    setCurrentWorkspaceIdentity({ path: "/fence.gdx", openRevision: 1 });
    const setEditable = vi.fn();
    const editor = {
      isDestroyed: false,
      setEditable,
    } as unknown as Editor;
    const key = {
      kind: "tree",
      id: "scene-db",
      storage: "database",
    } as const;
    renderHook(() =>
      useLicenseEditableSync(editor, false, key, "project-fence"),
    );

    let fence!: ReturnType<typeof acquireTimelapseReplacementFence>;
    act(() => {
      fence = acquireTimelapseReplacementFence({ projectId: "project-fence" });
    });
    expect(setEditable).toHaveBeenLastCalledWith(false, false);
    act(() => fence.release());
    expect(setEditable).toHaveBeenLastCalledWith(true, false);
  });

  it.each([
    "src/features/editor/EditorPane.tsx",
    "src/features/editor/LinearSceneBlock.tsx",
    "src/features/codex/components/CodexContentEditor.tsx",
    "src/features/snippets/SnippetDetailContent.tsx",
    "src/features/sticky/StickyBodyEditor.tsx",
    "src/features/editor/UnplacedBeatItem.tsx",
  ])("%s routes editable state through the shared hook", (relativePath) => {
    const source = readFileSync(resolve(process.cwd(), relativePath), "utf8");
    expect(source).toMatch(/useLicenseEditableSync\s*\(/);
  });

  it("EditorPane excludes unloaded documents from every mutation entry point", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/editor/EditorPane.tsx"),
      "utf8",
    );
    expect(source).toMatch(
      /useLicenseEditableSync\([\s\S]{0,100}?readOnly \|\| !inputProjectionReady,[\s\S]{0,80}?documentLeaseKey/,
    );
    expect(source).toMatch(
      /const loadedMountedEditor = inputProjectionReady \? mountedEditor : null/,
    );
    expect(source).toMatch(/setGlobalEditor\(loadedMountedEditor\)/);
    expect(source).toMatch(
      /getEditor: \(\) =>[\s\S]{0,160}?editorWritableRef\.current[\s\S]{0,100}?inputProjectionReadyRef\.current[\s\S]{0,80}?editorRef\.current/,
    );
    expect(source).toMatch(
      /onFocus\(\) \{[\s\S]{0,1200}?loadedDocumentKeyRef\.current\?\.id === nodeId[\s\S]{0,1200}?setCurrent\(\{ kind, id: nodeId \}, editorRef\.current\)/,
    );
    expect(source).toMatch(
      /mutationGate\.failLoad\(\);[\s\S]{0,220}?getFocusedEditor\(\) === editorRef\.current[\s\S]{0,100}?setCurrent\(null, null\)/,
    );
    expect(source).toMatch(
      /doc changed while unloaded[\s\S]{0,400}?return;[\s\S]{0,200}?editor\.onUpdate/,
    );
    expect(source).toMatch(
      /beats changed while unloaded[\s\S]{0,180}?return;[\s\S]{0,120}?schedule\(\)/,
    );
    expect(source).toMatch(
      /setIsDirtyRef\.current\(true\);[\s\S]{0,260}?setDocumentDirty\([\s\S]{0,120}?dirtyDocumentKey,[\s\S]{0,80}?true/,
    );
  });
});
