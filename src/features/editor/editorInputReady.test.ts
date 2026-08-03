// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import {
  EDITOR_INPUT_READY_EVENT,
  EDITOR_INPUT_READY_MARK,
  createEditorInputScopeKey,
  editorInputReadyMarkName,
  markEditorInputReady,
  waitForForegroundEditorInputReady,
} from "./editorInputReady";

const currentScopeKey = createEditorInputScopeKey({
  projectId: "project-current",
  workspacePath: "/workspace/current",
  workspaceOpenRevision: 2,
});
const oldScopeKey = createEditorInputScopeKey({
  projectId: "project-old",
  workspacePath: "/workspace/old",
  workspaceOpenRevision: 1,
});
const primaryWorkspaceProjection = {
  authority: "workspace" as const,
  groupIndex: 0 as const,
  foreground: true,
  scopeKey: currentScopeKey,
};

function appendWritableSurface(input: {
  documentId: string;
  documentKey: string;
  documentKind: "tree" | "codex" | "snippet" | "chronicle-event";
  scopeKey?: string;
  groupIndex?: 0 | 1;
  authority?: "workspace" | "linear" | "standalone";
  targetDocumentKey?: string;
  targetProjectionKey?: string;
  loadedProjectionKey?: string;
}): HTMLElement {
  const surface = document.createElement("div");
  const scopeKey = input.scopeKey ?? currentScopeKey;
  const targetProjectionKey =
    input.targetProjectionKey ?? `target:${input.documentKey}`;
  surface.dataset.editorTargetDocumentId = input.documentId;
  surface.dataset.editorTargetDocumentKey =
    input.targetDocumentKey ?? input.documentKey;
  surface.dataset.editorTargetDocumentKind = input.documentKind;
  surface.dataset.editorTargetProjectionKey = targetProjectionKey;
  surface.dataset.editorLoadedDocumentId = input.documentId;
  surface.dataset.editorLoadedDocumentKey = input.documentKey;
  surface.dataset.editorLoadedDocumentKind = input.documentKind;
  surface.dataset.editorLoadedProjectionKey =
    input.loadedProjectionKey ?? targetProjectionKey;
  surface.dataset.editorDocumentLoading = "false";
  surface.dataset.editorInputAuthority = input.authority ?? "workspace";
  surface.dataset.editorInputGroup = String(input.groupIndex ?? 0);
  surface.dataset.editorInputForeground = "true";
  surface.dataset.editorInputScopeKey = scopeKey;
  surface.dataset.editorLoadedScopeKey = scopeKey;
  const editor = document.createElement("div");
  editor.className = "ProseMirror";
  editor.contentEditable = "true";
  surface.appendChild(editor);
  document.body.appendChild(surface);
  return surface;
}

describe("markEditorInputReady", () => {
  it("marks only a canonical editor that is writable in both model and DOM", () => {
    const mark = vi
      .spyOn(performance, "mark")
      .mockImplementation(() => ({}) as PerformanceMark);
    const documentKey = {
      kind: "tree" as const,
      id: "scene-ready",
      storage: "database" as const,
    };

    expect(
      markEditorInputReady(
        documentKey,
        { isContentEditable: false } as HTMLElement,
        true,
        primaryWorkspaceProjection,
      ),
    ).toBe(false);
    expect(
      markEditorInputReady(
        documentKey,
        { isContentEditable: true } as HTMLElement,
        false,
        primaryWorkspaceProjection,
      ),
    ).toBe(false);
    expect(mark).not.toHaveBeenCalled();

    expect(
      markEditorInputReady(
        documentKey,
        { isContentEditable: true } as HTMLElement,
        true,
        primaryWorkspaceProjection,
      ),
    ).toBe(true);
    expect(editorInputReadyMarkName("scene ready")).toBe(
      `${EDITOR_INPUT_READY_MARK}:scene%20ready`,
    );
    expect(mark).toHaveBeenCalledWith(
      `${EDITOR_INPUT_READY_MARK}:scene-ready`,
      {
        detail: {
          documentId: "scene-ready",
          documentKey: "tree:database:scene-ready",
          documentKind: "tree",
          authority: "workspace",
          groupIndex: 0,
          scopeKey: currentScopeKey,
          foreground: true,
        },
      },
    );
  });

  it("releases background work only after a writable Editor announces readiness", async () => {
    const event = vi.fn();
    window.addEventListener(EDITOR_INPUT_READY_EVENT, event, { once: true });
    const pending = waitForForegroundEditorInputReady({ timeoutMs: 10_000 });

    markEditorInputReady(
      {
        kind: "tree",
        id: "scene-ready",
        storage: "database",
      },
      { isContentEditable: true } as HTMLElement,
      true,
      primaryWorkspaceProjection,
    );

    await expect(pending).resolves.toBe(true);
    expect(event).toHaveBeenCalledOnce();
  });

  it("matches canonical phase, group, and authority rather than a raw id", async () => {
    let settled = false;
    const pending = waitForForegroundEditorInputReady({
      timeoutMs: 10_000,
      expectedProjection: {
        authorities: ["workspace"],
        groupIndex: 1,
        documentId: "entry-restored",
        documentKey: "codex:entry-restored:phase:phase-restored",
        documentKind: "codex",
        scopeKey: currentScopeKey,
      },
    });
    void pending.then(() => {
      settled = true;
    });

    markEditorInputReady(
      {
        kind: "codex",
        id: "entry-restored",
        phaseId: "phase-provisional",
      },
      { isContentEditable: true } as HTMLElement,
      true,
      {
        authority: "workspace",
        groupIndex: 1,
        foreground: true,
        scopeKey: currentScopeKey,
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    markEditorInputReady(
      {
        kind: "codex",
        id: "entry-restored",
        phaseId: "phase-restored",
      },
      { isContentEditable: true } as HTMLElement,
      true,
      {
        authority: "workspace",
        groupIndex: 1,
        foreground: true,
        scopeKey: oldScopeKey,
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    markEditorInputReady(
      {
        kind: "codex",
        id: "entry-restored",
        phaseId: "phase-restored",
      },
      { isContentEditable: true } as HTMLElement,
      true,
      {
        authority: "standalone",
        groupIndex: 1,
        foreground: true,
        scopeKey: currentScopeKey,
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    markEditorInputReady(
      {
        kind: "codex",
        id: "entry-restored",
        phaseId: "phase-restored",
      },
      { isContentEditable: true } as HTMLElement,
      true,
      {
        authority: "workspace",
        groupIndex: 0,
        foreground: true,
        scopeKey: currentScopeKey,
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    markEditorInputReady(
      {
        kind: "codex",
        id: "entry-restored",
        phaseId: "phase-restored",
      },
      { isContentEditable: true } as HTMLElement,
      true,
      {
        authority: "workspace",
        groupIndex: 1,
        foreground: true,
        scopeKey: currentScopeKey,
      },
    );
    await expect(pending).resolves.toBe(true);
  });

  it("accepts only the expected already-writable Editor surface", async () => {
    const provisional = appendWritableSurface({
      documentId: "scene-provisional",
      documentKey: "tree:database:scene-provisional",
      documentKind: "tree",
    });

    const controller = new AbortController();
    const pending = waitForForegroundEditorInputReady({
      timeoutMs: 10_000,
      signal: controller.signal,
      expectedProjection: {
        authorities: ["workspace"],
        groupIndex: 0,
        documentKey: "tree:database:scene-restored",
        scopeKey: currentScopeKey,
      },
    });
    controller.abort();
    await expect(pending).resolves.toBe(false);

    await expect(
      waitForForegroundEditorInputReady({
        expectedProjection: {
          authorities: ["workspace"],
          groupIndex: 0,
          documentKey: "tree:database:scene-provisional",
          scopeKey: currentScopeKey,
        },
      }),
    ).resolves.toBe(true);
    provisional.remove();
  });

  it("rejects a writable surface retained from the previous workspace scope", async () => {
    const oldSurface = appendWritableSurface({
      documentId: "scene-shared-id",
      documentKey: "tree:database:scene-shared-id",
      documentKind: "tree",
      scopeKey: oldScopeKey,
    });
    const controller = new AbortController();
    const pending = waitForForegroundEditorInputReady({
      timeoutMs: 10_000,
      signal: controller.signal,
      expectedProjection: {
        authorities: ["workspace"],
        scopeKey: currentScopeKey,
        documentKey: "tree:database:scene-shared-id",
      },
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    controller.abort();
    await expect(pending).resolves.toBe(false);
    oldSurface.remove();

    const currentSurface = appendWritableSurface({
      documentId: "scene-shared-id",
      documentKey: "tree:database:scene-shared-id",
      documentKind: "tree",
      scopeKey: currentScopeKey,
    });
    await expect(
      waitForForegroundEditorInputReady({
        expectedProjection: {
          authorities: ["workspace"],
          scopeKey: currentScopeKey,
          documentKey: "tree:database:scene-shared-id",
        },
      }),
    ).resolves.toBe(true);
    currentSurface.remove();
  });

  it("rejects an old loaded Codex phase while the same pane targets a new phase", async () => {
    const surface = appendWritableSurface({
      documentId: "entry-shared-id",
      documentKey: "codex:entry-shared-id:phase:phase-old",
      documentKind: "codex",
      groupIndex: 1,
      targetDocumentKey: "codex:entry-shared-id:phase:phase-new",
      targetProjectionKey: "projection:new-phase",
      loadedProjectionKey: "projection:old-phase",
    });
    const expectedProjection = {
      authorities: ["workspace"] as const,
      scopeKey: currentScopeKey,
      groupIndex: 1 as const,
      documentId: "entry-shared-id",
      documentKind: "codex" as const,
      documentKey: "codex:entry-shared-id:phase:phase-new",
    };
    const controller = new AbortController();
    const pending = waitForForegroundEditorInputReady({
      timeoutMs: 10_000,
      signal: controller.signal,
      expectedProjection,
    });
    controller.abort();
    await expect(pending).resolves.toBe(false);

    surface.dataset.editorLoadedDocumentKey =
      "codex:entry-shared-id:phase:phase-new";
    surface.dataset.editorLoadedProjectionKey = "projection:new-phase";
    await expect(
      waitForForegroundEditorInputReady({ expectedProjection }),
    ).resolves.toBe(true);
    surface.remove();
  });

  it("falls back for projects without an active Editor and supports cancellation", async () => {
    vi.useFakeTimers();
    const timedOut = waitForForegroundEditorInputReady({ timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    await expect(timedOut).resolves.toBe(false);

    const controller = new AbortController();
    const cancelled = waitForForegroundEditorInputReady({
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(cancelled).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("does not start background work while an Editor is still loading", async () => {
    vi.useFakeTimers();
    const loadingSurface = document.createElement("div");
    loadingSurface.dataset.editorDocumentLoading = "true";
    loadingSurface.dataset.editorInputAuthority = "workspace";
    loadingSurface.dataset.editorInputGroup = "0";
    loadingSurface.dataset.editorInputForeground = "true";
    loadingSurface.dataset.editorInputScopeKey = currentScopeKey;
    document.body.appendChild(loadingSurface);

    let settled = false;
    const pending = waitForForegroundEditorInputReady({ timeoutMs: 25 });
    void pending.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(25);
    expect(settled).toBe(false);

    loadingSurface.remove();
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toBe(false);
    vi.useRealTimers();
  });

  it("does not announce a hidden, background, or standalone projection", () => {
    const hiddenGroup = document.createElement("div");
    hiddenGroup.setAttribute("aria-hidden", "true");
    const editorDom = document.createElement("div");
    editorDom.contentEditable = "true";
    hiddenGroup.appendChild(editorDom);
    document.body.appendChild(hiddenGroup);

    const documentKey = {
      kind: "tree" as const,
      id: "scene-hidden",
      storage: "database" as const,
    };
    expect(
      markEditorInputReady(documentKey, editorDom, true, {
        authority: "workspace",
        groupIndex: 0,
        foreground: true,
        scopeKey: currentScopeKey,
      }),
    ).toBe(false);

    hiddenGroup.removeAttribute("aria-hidden");
    expect(
      markEditorInputReady(documentKey, editorDom, true, {
        authority: "workspace",
        groupIndex: 0,
        foreground: false,
        scopeKey: currentScopeKey,
      }),
    ).toBe(false);
    hiddenGroup.remove();
  });
});
