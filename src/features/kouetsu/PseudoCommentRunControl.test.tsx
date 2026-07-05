// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useAnnotationStore } from "@/features/post-effect/annotationStore";
import type { PostEffectAnnotation } from "@/features/post-effect/types";

const h = vi.hoisted(() => ({
  runPostEffect: vi.fn(),
  buildPseudoCommentPayload: vi.fn(),
  invoke: vi.fn(),
}));

// 疑似コメント生成後の scene 反映は listAnnotationsForScene（実物）→ invoke
// を通る。list_annotations_for_scene だけ既知の annotation を返し、他は undefined。
const SAMPLE_ANNOTATIONS = [
  { id: "a1", sceneId: "s1", status: "open" },
] as unknown as PostEffectAnnotation[];

vi.mock("@/lib/tauri", () => ({ invoke: h.invoke, listen: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));
vi.mock("@/features/ai-policy/useAiGate", () => ({
  useAiGate: () => ({ presentation: "enabled", tooltip: undefined }),
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
  LICENSE_WRITE_RESTRICTED_ERROR: "license",
}));
vi.mock("@/features/chat/store", () => ({
  useAiSettingsStore: {
    getState: () => ({
      settings: { model: "test-model" },
      loadSettings: vi.fn(),
    }),
  },
}));
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: () => ({}),
}));
vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({ get: (_key: string, fallback: string) => fallback }),
  },
}));
vi.mock("@/features/project/contextAtoms", () => ({
  fetchProjectContext: () => Promise.resolve(null),
}));
vi.mock("@/prompts/index", () => ({
  getPromptCatalog: () => ({ postEffect: { pseudoCommentSystem: "SYS" } }),
}));
// buildPseudoCommentPayload は db に触れるため差し替え。ペルソナ集合・brief
// 解決などのヘルパは実物を使う（persona select / disable 判定を実挙動で検証）。
vi.mock("@/features/post-effect/pseudoCommentPayloadBuilder", async (orig) => {
  const actual =
    await orig<
      typeof import("@/features/post-effect/pseudoCommentPayloadBuilder")
    >();
  return { ...actual, buildPseudoCommentPayload: h.buildPseudoCommentPayload };
});
// flushPendingSceneSaves は実物（save handler 未登録なら resolve）。
vi.mock("@/features/post-effect/api", async (orig) => {
  const actual = await orig<typeof import("@/features/post-effect/api")>();
  return { ...actual, runPostEffect: h.runPostEffect };
});

import { PseudoCommentRunControl } from "./PseudoCommentRunControl";

describe("PseudoCommentRunControl", () => {
  beforeEach(() => {
    h.runPostEffect.mockReset();
    h.buildPseudoCommentPayload.mockReset();
    h.invoke.mockReset();
    // 実 annotationStore を毎回リセット（scene 反映の検証を独立させる）。
    useAnnotationStore.setState({ annotationsByScene: new Map() });
    h.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "list_annotations_for_scene") {
        return { annotations: SAMPLE_ANNOTATIONS };
      }
      return undefined;
    });
    h.buildPseudoCommentPayload.mockResolvedValue({
      inputHash: "hash-1",
      sceneText: "本文",
    });
    h.runPostEffect.mockImplementation(
      async (_req: unknown, cb: { onDone?: (e: unknown) => void }) => {
        cb.onDone?.({ run_id: "r1", annotation_count: 0, from_cache: false });
        return { runId: "r1", cleanup: () => {} };
      },
    );
  });

  afterEach(() => {
    cleanup();
  });

  it("アクティブシーンなしでは実行ボタンが disabled", () => {
    useTreeStore.setState({ activeSceneId: "", projectId: "p1" });
    render(<PseudoCommentRunControl onCompleted={() => {}} />);
    expect(screen.getByRole("button", { name: /AIコメント/ })).toBeDisabled();
  });

  it("ペルソナを選んで実行すると effect_type=pseudo_comment / scope=scene で起動する", async () => {
    useTreeStore.setState({ activeSceneId: "s1", projectId: "p1" });
    render(<PseudoCommentRunControl onCompleted={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /AIコメント/ }));
    await waitFor(() => expect(h.runPostEffect).toHaveBeenCalled());
    const req = h.runPostEffect.mock.calls[0][0] as Record<string, unknown>;
    expect(req.effect_type).toBe("pseudo_comment");
    expect(req.scope_type).toBe("scene");
    expect(req.scope_target_id).toBe("s1");
  });

  it("完了時に onCompleted を呼ぶ", async () => {
    const onCompleted = vi.fn();
    useTreeStore.setState({ activeSceneId: "s1", projectId: "p1" });
    render(<PseudoCommentRunControl onCompleted={onCompleted} />);
    fireEvent.click(screen.getByRole("button", { name: /AIコメント/ }));
    await waitFor(() => expect(onCompleted).toHaveBeenCalled());
  });

  // Finding 1 の回帰ガード: 生成後に scene 単位の annotation 反映経路
  // (listAnnotationsForScene → annotationStore.setAnnotations) が走ること。
  // これで本文の peAnnotation ハイライトが即時同期する（applyAnnotationsToEditor
  // は editor 未取得＝null なら no-op なので、ここでは store 反映で担保する）。
  it("完了後に対象シーンの annotation を再取得して annotationStore へ反映する", async () => {
    useTreeStore.setState({ activeSceneId: "s1", projectId: "p1" });
    render(<PseudoCommentRunControl onCompleted={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /AIコメント/ }));
    await waitFor(() =>
      expect(h.invoke).toHaveBeenCalledWith(
        "list_annotations_for_scene",
        expect.objectContaining({ projectId: "p1", sceneId: "s1" }),
      ),
    );
    await waitFor(() =>
      expect(
        useAnnotationStore.getState().annotationsByScene.get("s1"),
      ).toEqual(SAMPLE_ANNOTATIONS),
    );
  });
});
