import {
  encodeDocumentKey,
  type DocumentKey,
} from "@/features/editor/document/documentKey";

export const EDITOR_INPUT_READY_MARK = "grimodex.editorInputReady";
export const EDITOR_INPUT_READY_EVENT = "grimodex:editor-input-ready";

export type EditorInputAuthority = "workspace" | "linear" | "standalone";
export type EditorInputGroup = 0 | 1 | null;
export type EditorInputScopeKey = string & {
  readonly __editorInputScopeKey: unique symbol;
};

export function createEditorInputScopeKey(input: {
  projectId: string | null;
  workspacePath: string | null;
  workspaceOpenRevision: number;
}): EditorInputScopeKey {
  return JSON.stringify([
    "editor-input-v1",
    input.workspacePath,
    input.workspaceOpenRevision,
    input.projectId,
  ]) as EditorInputScopeKey;
}

export interface EditorInputProjection {
  authority: EditorInputAuthority;
  groupIndex: EditorInputGroup;
  foreground: boolean;
  scopeKey: EditorInputScopeKey;
}

export interface EditorInputReadyDetail extends EditorInputProjection {
  documentId: string;
  documentKey: string;
  documentKind: DocumentKey["kind"];
  foreground: true;
}

export interface ExpectedEditorInputProjection {
  authorities?: readonly EditorInputAuthority[];
  groupIndex?: EditorInputGroup;
  documentId?: string;
  documentKey?: string;
  documentKind?: DocumentKey["kind"];
  scopeKey?: EditorInputScopeKey;
}

interface WaitForEditorInputReadyOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Match the actual rendered projection, not merely a raw document id.
   * A canonical key distinguishes Codex phases, while group and authority keep
   * hidden split panes and standalone panel editors from releasing the
   * workspace gate.
   */
  expectedProjection?: ExpectedEditorInputProjection;
}

export function editorInputReadyMarkName(documentId: string): string {
  return `${EDITOR_INPUT_READY_MARK}:${encodeURIComponent(documentId)}`;
}

/**
 * Record the moment a canonical editor binding is actually writable.
 *
 * Shell/header visibility is not sufficient: the editor can still contain a
 * read-only placeholder while its body and sidecars load. Keeping this mark at
 * the editor boundary gives runtime tests and diagnostics the same readiness
 * definition as a real keystroke.
 */
export function markEditorInputReady(
  documentKey: DocumentKey,
  editorDom: HTMLElement,
  editorIsEditable: boolean,
  projection: EditorInputProjection,
): boolean {
  if (
    !projection.foreground ||
    !editorIsEditable ||
    !editorDom.isContentEditable ||
    !isProjectionVisible(editorDom)
  ) {
    return false;
  }

  const encodedDocumentKey = encodeDocumentKey(documentKey);
  const detail: EditorInputReadyDetail = {
    documentId: documentKey.id,
    documentKey: encodedDocumentKey,
    documentKind: documentKey.kind,
    authority: projection.authority,
    groupIndex: projection.groupIndex,
    scopeKey: projection.scopeKey,
    foreground: true,
  };
  performance.mark(editorInputReadyMarkName(documentKey.id), {
    detail,
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(EDITOR_INPUT_READY_EVENT, {
        detail,
      }),
    );
  }
  return true;
}

function isProjectionVisible(element: HTMLElement): boolean {
  return (
    typeof element.closest !== "function" ||
    element.closest('[hidden], [aria-hidden="true"], [inert]') === null
  );
}

function parseSurfaceProjection(
  surface: HTMLElement,
): Omit<EditorInputReadyDetail, "foreground"> | null {
  const {
    editorInputAuthority,
    editorInputGroup,
    editorLoadedDocumentId,
    editorLoadedDocumentKey,
    editorLoadedDocumentKind,
    editorInputScopeKey,
  } = surface.dataset;
  if (
    editorInputAuthority !== "workspace" &&
    editorInputAuthority !== "linear" &&
    editorInputAuthority !== "standalone"
  ) {
    return null;
  }
  const groupIndex =
    editorInputGroup === "none"
      ? null
      : editorInputGroup === "0"
        ? 0
        : editorInputGroup === "1"
          ? 1
          : undefined;
  if (
    groupIndex === undefined ||
    !editorLoadedDocumentId ||
    !editorLoadedDocumentKey ||
    !editorInputScopeKey ||
    (editorLoadedDocumentKind !== "tree" &&
      editorLoadedDocumentKind !== "codex" &&
      editorLoadedDocumentKind !== "snippet" &&
      editorLoadedDocumentKind !== "chronicle-event")
  ) {
    return null;
  }
  return {
    documentId: editorLoadedDocumentId,
    documentKey: editorLoadedDocumentKey,
    documentKind: editorLoadedDocumentKind,
    authority: editorInputAuthority,
    groupIndex,
    scopeKey: editorInputScopeKey as EditorInputScopeKey,
  };
}

function matchesExpectedProjection(
  projection: Omit<EditorInputReadyDetail, "foreground">,
  expected?: ExpectedEditorInputProjection,
): boolean {
  if (!expected) return true;
  return (
    (!expected.authorities ||
      expected.authorities.includes(projection.authority)) &&
    (expected.groupIndex === undefined ||
      expected.groupIndex === projection.groupIndex) &&
    (expected.documentId === undefined ||
      expected.documentId === projection.documentId) &&
    (expected.documentKey === undefined ||
      expected.documentKey === projection.documentKey) &&
    (expected.documentKind === undefined ||
      expected.documentKind === projection.documentKind) &&
    (expected.scopeKey === undefined ||
      expected.scopeKey === projection.scopeKey)
  );
}

function isReadyDetail(value: unknown): value is EditorInputReadyDetail {
  if (!value || typeof value !== "object") return false;
  const detail = value as Partial<EditorInputReadyDetail>;
  return (
    typeof detail.documentId === "string" &&
    typeof detail.documentKey === "string" &&
    (detail.documentKind === "tree" ||
      detail.documentKind === "codex" ||
      detail.documentKind === "snippet" ||
      detail.documentKind === "chronicle-event") &&
    (detail.authority === "workspace" ||
      detail.authority === "linear" ||
      detail.authority === "standalone") &&
    (detail.groupIndex === 0 ||
      detail.groupIndex === 1 ||
      detail.groupIndex === null) &&
    typeof detail.scopeKey === "string" &&
    detail.foreground === true
  );
}

function surfaceLoadedTargetIsCurrent(surface: HTMLElement): boolean {
  const {
    editorInputScopeKey,
    editorLoadedDocumentId,
    editorLoadedDocumentKey,
    editorLoadedDocumentKind,
    editorLoadedProjectionKey,
    editorLoadedScopeKey,
    editorTargetDocumentId,
    editorTargetDocumentKey,
    editorTargetDocumentKind,
    editorTargetProjectionKey,
  } = surface.dataset;
  return (
    Boolean(editorInputScopeKey) &&
    editorLoadedScopeKey === editorInputScopeKey &&
    Boolean(editorTargetDocumentId) &&
    editorTargetDocumentId === editorLoadedDocumentId &&
    Boolean(editorTargetDocumentKind) &&
    editorTargetDocumentKind === editorLoadedDocumentKind &&
    Boolean(editorTargetProjectionKey) &&
    editorTargetProjectionKey === editorLoadedProjectionKey &&
    (!editorTargetDocumentKey ||
      editorTargetDocumentKey === editorLoadedDocumentKey)
  );
}

function hasWritableEditorSurface(
  expected?: ExpectedEditorInputProjection,
): boolean {
  if (typeof document === "undefined") return false;
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-editor-input-foreground="true"][data-editor-loaded-document-key]:not([data-editor-loaded-document-key=""])[data-editor-document-loading="false"]',
    ),
  ).some((surface) => {
    if (!isProjectionVisible(surface)) return false;
    if (!surfaceLoadedTargetIsCurrent(surface)) return false;
    const projection = parseSurfaceProjection(surface);
    if (!projection || !matchesExpectedProjection(projection, expected))
      return false;
    const editor = surface.querySelector<HTMLElement>(
      '.ProseMirror[contenteditable="true"]',
    );
    return editor?.isContentEditable === true && isProjectionVisible(editor);
  });
}

function loadingSurfaceMatchesExpectedProjection(
  surface: HTMLElement,
  expected?: ExpectedEditorInputProjection,
): boolean {
  if (!expected) return true;
  const authority = surface.dataset.editorInputAuthority;
  const group =
    surface.dataset.editorInputGroup === "none"
      ? null
      : surface.dataset.editorInputGroup === "0"
        ? 0
        : surface.dataset.editorInputGroup === "1"
          ? 1
          : undefined;
  return (
    (!expected.authorities ||
      (authority !== undefined &&
        expected.authorities.includes(authority as EditorInputAuthority))) &&
    (expected.groupIndex === undefined || expected.groupIndex === group) &&
    (expected.documentId === undefined ||
      expected.documentId === surface.dataset.editorTargetDocumentId) &&
    (expected.documentKind === undefined ||
      expected.documentKind === surface.dataset.editorTargetDocumentKind) &&
    (expected.scopeKey === undefined ||
      expected.scopeKey === surface.dataset.editorInputScopeKey)
  );
}

function hasLoadingEditorSurface(
  expected?: ExpectedEditorInputProjection,
): boolean {
  if (typeof document === "undefined") return false;
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-editor-input-foreground="true"][data-editor-document-loading="true"]',
    ),
  ).some(
    (surface) =>
      isProjectionVisible(surface) &&
      loadingSurfaceMatchesExpectedProjection(surface, expected),
  );
}

/**
 * Keep rebuildable background work behind the first foreground Editor load.
 *
 * Semantic bulk indexing can repeatedly acquire SQLite between items. Starting
 * it before the canonical Editor has loaded its body and sidecars can therefore
 * starve the read lane even though derived work has its own IPC slot. Projects
 * without an active Editor fall back after the timeout so indexing is not
 * permanently suppressed.
 */
export function waitForForegroundEditorInputReady(
  options: WaitForEditorInputReadyOptions = {},
): Promise<boolean> {
  const { timeoutMs = 30_000, signal, expectedProjection } = options;
  if (typeof window === "undefined") return Promise.resolve(false);
  if (signal?.aborted) return Promise.resolve(false);
  if (hasWritableEditorSurface(expectedProjection)) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout: number | null = null;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener(EDITOR_INPUT_READY_EVENT, onReady);
      signal?.removeEventListener("abort", onAbort);
      if (timeout !== null) clearTimeout(timeout);
      resolve(ready);
    };
    const onReady = (event: Event) => {
      if (!(event instanceof CustomEvent) || !isReadyDetail(event.detail)) {
        return;
      }
      if (!matchesExpectedProjection(event.detail, expectedProjection)) {
        return;
      }
      finish(true);
    };
    const onAbort = () => finish(false);
    const armTimeout = () => {
      timeout = window.setTimeout(() => {
        // A present Editor still loading its canonical body/sidecars remains
        // foreground authority. Re-arm instead of starting bulk indexing at
        // the exact timeout that the Editor is already struggling to cross.
        // Projects with no Editor (or a terminal non-loading surface) retain
        // the bounded fail-open behavior.
        if (hasLoadingEditorSurface(expectedProjection)) {
          armTimeout();
          return;
        }
        finish(false);
      }, timeoutMs);
    };

    window.addEventListener(EDITOR_INPUT_READY_EVENT, onReady);
    signal?.addEventListener("abort", onAbort, { once: true });
    armTimeout();
    // Close the check-to-subscribe race if the Editor became writable between
    // the initial DOM check and listener registration.
    if (hasWritableEditorSurface(expectedProjection)) finish(true);
  });
}
