// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// DA-2b の PUB-G 前の必須 5（DR-DA2B-R29）：編集の時点で、再送が送信の capture に入る
// route かを、capture と同じ関数（`captureRouteIsEligible`）と、送信の preflight の route の
// 写し（`resolveCurrentChatTurnPolicy`）で評価する。本物の設定 store と route の解決を使う。

import {
  isEditResendCaptureEligible,
  snapshotEditTarget,
  type EditCaptureState,
} from "./chatEgressClosure";
import { useAiSettingsStore } from "./store";
import * as routing from "@/application/chat/chatTurnRouting";
import {
  configureCloudRoute,
  configureOpenaiCompatibleRoute,
} from "./editCaptureRoute.testSupport";

const NO_COMMAND = { commandInstruction: undefined };

const scene: EditCaptureState = {
  agentMode: false,
  ragEnabled: false,
  chatScope: "scene",
  activeSceneId: "scene-1",
  scopeAnchorId: null,
  threadFocusOverride: null,
  activeProjectId: "p1",
  activeSessionId: "s1",
  isStreaming: false,
  messages: [
    { id: "u1", role: "user", metadata: null },
    { id: "a1", role: "assistant" },
  ],
};

function installBridge() {
  (window as unknown as { grimodex: unknown }).grimodex = {
    invoke: vi.fn(),
    listen: vi.fn(() => () => undefined),
  };
}

describe("isEditResendCaptureEligible（編集の時点の route の判定）", () => {
  beforeEach(() => {
    installBridge();
    configureOpenaiCompatibleRoute();
  });
  afterEach(() => {
    delete (window as unknown as { grimodex?: unknown }).grimodex;
    vi.restoreAllMocks();
  });

  it("loopback の OpenAI 互換で、agent・RAG・mention が無い場面の会話は capture の内", () => {
    expect(isEditResendCaptureEligible(scene, "u1", undefined)).toBe(true);
    expect(snapshotEditTarget(scene, "u1", NO_COMMAND)).toMatchObject({
      sceneConversation: true,
      captureEligible: true,
    });
  });

  it.each([
    ["agent", () => ({ ...scene, agentMode: true })],
    ["RAG", () => ({ ...scene, ragEnabled: true })],
    [
      "対象の行の scene の mention",
      () => ({
        ...scene,
        messages: [
          {
            id: "u1",
            role: "user",
            metadata: JSON.stringify({ mentioned_scene_ids: ["scene-2"] }),
          },
        ],
      }),
    ],
    [
      "cloud の provider",
      () => {
        configureCloudRoute();
        return scene;
      },
    ],
    [
      "loopback でない OpenAI 互換",
      () => {
        configureOpenaiCompatibleRoute("http://192.168.1.20:12345/v1");
        return scene;
      },
    ],
    [
      "localhost の綴り",
      () => {
        configureOpenaiCompatibleRoute("http://localhost:12345/v1");
        return scene;
      },
    ],
    [
      "composer の model の上書き",
      () => {
        useAiSettingsStore.setState({ chatModelOverride: "other-model" });
        return scene;
      },
    ],
    [
      "設定が無い",
      () => {
        useAiSettingsStore.setState({ settings: null });
        return scene;
      },
    ],
    [
      "Electron の外（bridge が無い）",
      () => {
        delete (window as unknown as { grimodex?: unknown }).grimodex;
        return scene;
      },
    ],
    [
      "thread の focus",
      () => ({ ...scene, threadFocusOverride: { threadId: "t", title: "t" } }),
    ],
    ["対象の行が無い", () => ({ ...scene, messages: [] })],
  ] as Array<[string, () => EditCaptureState]>)(
    "%s は capture の外（偽）",
    (_label, arrange) => {
      const state = arrange();
      expect(isEditResendCaptureEligible(state, "u1", undefined)).toBe(false);
      expect(snapshotEditTarget(state, "u1", NO_COMMAND).captureEligible).toBe(
        false,
      );
    },
  );

  it("非場面の会話は route が capture の内でも偽", () => {
    const project = { ...scene, chatScope: "project" };
    expect(snapshotEditTarget(project, "u1", NO_COMMAND)).toMatchObject({
      sceneConversation: false,
      captureEligible: false,
    });
  });

  // 独立レビューの P2-1（DR-DA2B-R32）：保留中の slash command の指示は再送に付く。
  it("保留中の command の指示があれば capture の外（偽）", () => {
    expect(isEditResendCaptureEligible(scene, "u1", "instruction")).toBe(false);
    expect(
      snapshotEditTarget(scene, "u1", { commandInstruction: "instruction" })
        .captureEligible,
    ).toBe(false);
  });

  it("保留中の command が読めない（null）なら capture の外（偽）", () => {
    expect(snapshotEditTarget(scene, "u1", null).captureEligible).toBe(false);
  });

  it("route の解決が投げたら偽（閉の側）", () => {
    vi.spyOn(routing, "resolveCurrentChatTurnPolicy").mockImplementation(() => {
      throw new Error("route unavailable");
    });
    expect(isEditResendCaptureEligible(scene, "u1", undefined)).toBe(false);
  });
});
