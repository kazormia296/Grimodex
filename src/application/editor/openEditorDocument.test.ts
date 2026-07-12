import { describe, expect, it, vi } from "vitest";
import {
  openEditorDocument,
  type EditorNavigationPorts,
} from "./openEditorDocument";

function ports(): EditorNavigationPorts & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    tabs: {
      openPreview: vi.fn((id) => calls.push(`preview:${id}`)),
      openPinned: vi.fn((id) => calls.push(`pinned:${id}`)),
      openCodexTab: vi.fn((id) => calls.push(`codex:${id}`)),
      openSnippetTab: vi.fn((id) => calls.push(`snippet:${id}`)),
      openChronicleEventTab: vi.fn((id) => calls.push(`event:${id}`)),
      openInSecondaryGroup: vi.fn((id) => calls.push(`secondary:${id}`)),
      openInSecondaryGroupDirectional: vi.fn((id, direction) =>
        calls.push(`secondary:${id}:${direction}`),
      ),
      requestEditorFocus: vi.fn((group) => calls.push(`focus:${group}`)),
    },
    layout: { showEditor: vi.fn(() => calls.push("layout")) },
    tree: { setActiveScene: vi.fn((id) => calls.push(`scene:${id}`)) },
  };
}

describe("openEditorDocument", () => {
  it("coordinates a pinned scene without changing layout when reveal is false", () => {
    const navigation = ports();

    openEditorDocument(
      {
        target: { kind: "scene", documentId: "scene-1" },
        mode: "pinned",
        revealEditor: false,
        focusEditor: false,
        syncSceneContext: true,
      },
      navigation,
    );

    expect(navigation.calls).toEqual(["pinned:scene-1", "scene:scene-1"]);
    expect(navigation.layout.showEditor).not.toHaveBeenCalled();
  });

  it("reveals a pinned document when scene sync is disabled", () => {
    const navigation = ports();

    openEditorDocument(
      {
        target: { kind: "scene", documentId: "scene-redo" },
        mode: "pinned",
        revealEditor: true,
        focusEditor: false,
        syncSceneContext: false,
      },
      navigation,
    );

    expect(navigation.calls).toEqual(["pinned:scene-redo", "layout"]);
  });

  it("does not partially update tabs, tree, or layout while blocked", () => {
    const navigation = ports();
    navigation.isNavigationBlocked = () => true;

    openEditorDocument(
      {
        target: { kind: "scene", documentId: "scene-2" },
        mode: "pinned",
        revealEditor: true,
        focusEditor: true,
        syncSceneContext: true,
      },
      navigation,
    );

    expect(navigation.calls).toEqual([]);
  });

  it("keeps non-scene identity and opens secondary scenes directionally", () => {
    const navigation = ports();

    openEditorDocument(
      {
        target: { kind: "codex", documentId: "codex-1", phaseId: "phase-1" },
        mode: "pinned",
        revealEditor: true,
        focusEditor: false,
        syncSceneContext: false,
      },
      navigation,
    );
    openEditorDocument(
      {
        target: { kind: "scene", documentId: "scene-3" },
        group: 1,
        mode: "pinned",
        revealEditor: false,
        focusEditor: true,
        syncSceneContext: true,
        splitDirection: "below",
      },
      navigation,
    );

    expect(navigation.calls).toEqual([
      "codex:codex-1",
      "layout",
      "secondary:scene-3:below",
      "scene:scene-3",
      "focus:1",
    ]);
  });
});
