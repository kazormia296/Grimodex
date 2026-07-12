import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UnifiedIssue } from "./issueModel";

const h = vi.hoisted(() => ({
  activeSceneId: "scene-current",
  editor: null as { state: { doc: { content: { size: number } } } } | null,
  editorVisible: false,
  openEditorDocument: vi.fn(),
  requestJump: vi.fn(),
  navigationPorts: {},
}));

vi.mock("@/lib/i18n", () => ({
  default: { t: (key: string) => key },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({
      activeSceneId: h.activeSceneId,
      projectId: "project-a",
    }),
  },
}));

vi.mock("@/features/layout/layoutStore", () => ({
  useLayoutStore: {
    getState: () => ({ isPanelActive: () => h.editorVisible }),
  },
}));

vi.mock("@/application/editor/openEditorDocument", () => ({
  openEditorDocument: h.openEditorDocument,
}));

vi.mock("@/features/editor/editorNavigationPorts", () => ({
  defaultEditorNavigationPorts: h.navigationPorts,
}));

vi.mock("@/features/editor/editorStore", () => ({
  useEditorStore: { getState: () => ({ editor: h.editor }) },
}));

vi.mock("@/features/post-effect/annotationStore", () => ({
  useAnnotationStore: {
    getState: () => ({
      setFocusedAnnotationId: vi.fn(),
      updateAnnotationStatus: vi.fn(),
    }),
  },
}));

vi.mock("@/features/lint/lintProjectStore", () => ({
  useLintProjectStore: {
    getState: () => ({ requestJump: h.requestJump }),
  },
}));

vi.mock("@/features/lint/lintActions", () => ({
  applyLintFix: vi.fn(),
  jumpToDiagnostic: vi.fn(),
}));

vi.mock("@/features/post-effect/closeAnnotation", () => ({
  closeAnnotation: vi.fn(),
}));

vi.mock("@/features/post-effect/typoFix", () => ({
  applyTypoFixAndResolve: vi.fn(),
}));

vi.mock("@/features/post-effect/api", () => ({
  updateAnnotationStatus: vi.fn(),
}));

vi.mock("@/features/post-effect/errorToast", () => ({
  postEffectErrorToast: vi.fn(),
}));

vi.mock("../runners", () => ({
  runConsistencyCheck: vi.fn(),
  runIntentDriftCheck: vi.fn(),
  runMetaStructureCheck: vi.fn(),
  runReviewCheck: vi.fn(),
  runTimelineCheck: vi.fn(),
  runTypoCheck: vi.fn(),
}));

import { jumpToIssue, openSceneInEditor } from "./issueActions";

function lintIssue(sceneId: string): UnifiedIssue {
  return {
    id: `lint:${sceneId}:0:test/rule`,
    cat: "linter",
    sev: "mid",
    sceneId,
    title: "diagnostic",
    meta: { kind: "rule", ruleId: "test/rule" },
    excerpt: null,
    quote: null,
    compare: null,
    suggest: null,
    fixable: false,
    confidence: null,
    createdAt: null,
    source: {
      kind: "lint",
      sceneId,
      diag: {
        rule_id: "test/rule",
        severity: "warning",
        message: "diagnostic",
        range: { start: 2, end: 4 },
      },
    },
  };
}

describe("issueActions editor navigation", () => {
  beforeEach(() => {
    h.activeSceneId = "scene-current";
    h.editor = null;
    h.editorVisible = false;
    h.openEditorDocument.mockClear();
    h.requestJump.mockClear();
  });

  it("reveals the editor for a deferred lint jump", () => {
    jumpToIssue(lintIssue("scene-target"));

    expect(h.requestJump).toHaveBeenCalledWith({
      sceneId: "scene-target",
      range: { start: 2, end: 4 },
    });
    expect(h.openEditorDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: "scene", documentId: "scene-target" },
        revealEditor: true,
        syncSceneContext: true,
      }),
      h.navigationPorts,
    );
  });

  it("preserves the current conditional reveal for ordinary scene selection", () => {
    openSceneInEditor("scene-target");

    expect(h.openEditorDocument).toHaveBeenCalledWith(
      expect.objectContaining({ revealEditor: false }),
      h.navigationPorts,
    );
  });
});
