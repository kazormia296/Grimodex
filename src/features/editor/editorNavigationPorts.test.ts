import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  __resetChatNavigationGuardForTests,
  setChatSceneTransitionBlocker,
} from "@/lib/chatNavigationGuard";
import { defaultEditorNavigationPorts } from "./editorNavigationPorts";

const commandFor = (documentId: string) => ({
  target: { kind: "scene" as const, documentId },
  mode: "pinned" as const,
  revealEditor: true,
  focusEditor: false,
  syncSceneContext: true,
});

beforeEach(() => {
  __resetChatNavigationGuardForTests();
  useTreeStore.setState({ activeSceneId: "scene-committed" });
});

afterEach(() => {
  __resetChatNavigationGuardForTests();
});

describe("defaultEditorNavigationPorts", () => {
  it("allows revealing the Scene whose Tree authority already committed", () => {
    setChatSceneTransitionBlocker(() => true);

    expect(
      defaultEditorNavigationPorts.isNavigationBlocked?.(
        commandFor("scene-committed"),
      ),
    ).toBe(false);
  });

  it("keeps a different Scene blocked while persistence is sticky", () => {
    setChatSceneTransitionBlocker(() => true);

    expect(
      defaultEditorNavigationPorts.isNavigationBlocked?.(
        commandFor("scene-other"),
      ),
    ).toBe(true);
  });
});
