import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  registerSaveHandler,
  unregisterSaveHandler,
  saveScene,
  saveDocument,
  registeredSaveHandlerIds,
  dirtyGatedSaveHandler,
  announcePersistedBinding,
  registerPersistedBindingHandler,
  unregisterPersistedBindingHandler,
  discardDocumentInGroup,
  registerDiscardHandler,
  unregisterDiscardHandler,
} from "./editorSaveRegistry";
import {
  createEditorInstanceId,
  type DocumentKey,
} from "./document/documentKey";
import { createEditorMutationGate } from "./document/mutationGate";
import type { LoadedEditorBinding } from "./document/types";

beforeEach(() => {
  // モジュールシングルトンの Map を空にする (テスト間リーク防止)
  for (const id of registeredSaveHandlerIds()) {
    unregisterSaveHandler(id);
  }
});

describe("editorSaveRegistry", () => {
  it("登録した handler を saveScene が呼ぶ / 未登録は no-op", async () => {
    const fn = vi.fn(async () => {});
    registerSaveHandler("n1", fn);
    await saveScene("n1");
    expect(fn).toHaveBeenCalledTimes(1);
    await saveScene("unknown");
  });

  it("registeredSaveHandlerIds は登録中の全 id を返す", () => {
    registerSaveHandler("n1", async () => {});
    registerSaveHandler("n2", async () => {});
    expect(registeredSaveHandlerIds().sort()).toEqual(["n1", "n2"]);
    unregisterSaveHandler("n1");
    expect(registeredSaveHandlerIds()).toEqual(["n2"]);
  });

  it("fn 指定の unregister は、新インスタンスが先に再登録していたら消さない (remount 競合ガード)", async () => {
    const oldFn = vi.fn(async () => {});
    const newFn = vi.fn(async () => {});
    registerSaveHandler("n1", oldFn);
    // remount: 新インスタンスの register が旧 cleanup より先に走るケース
    registerSaveHandler("n1", newFn);
    unregisterSaveHandler("n1", oldFn);

    await saveScene("n1");
    expect(newFn).toHaveBeenCalledTimes(1);
    expect(oldFn).not.toHaveBeenCalled();

    // 自分自身の fn なら消える
    unregisterSaveHandler("n1", newFn);
    expect(registeredSaveHandlerIds()).toEqual([]);
  });

  it("fn 省略の unregister は無条件で消す (後方互換)", () => {
    registerSaveHandler("n1", async () => {});
    unregisterSaveHandler("n1");
    expect(registeredSaveHandlerIds()).toEqual([]);
  });

  it("同じ文書の複数 editor instance を個別に登録・解除する", async () => {
    const key: DocumentKey = {
      kind: "codex",
      id: "entry-1",
      phaseId: "phase-1",
    };
    const firstId = createEditorInstanceId("test");
    const secondId = createEditorInstanceId("test");
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});

    registerSaveHandler(key, firstId, first);
    registerSaveHandler(key, secondId, second);
    await saveDocument(key);

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();

    unregisterSaveHandler(key, firstId, first);
    await saveDocument(key);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("Codex base と Phase の exact flush を混線させない", async () => {
    const base: DocumentKey = {
      kind: "codex",
      id: "entry-1",
      phaseId: null,
    };
    const phase: DocumentKey = {
      kind: "codex",
      id: "entry-1",
      phaseId: "phase-1",
    };
    const baseSave = vi.fn(async () => {});
    const phaseSave = vi.fn(async () => {});
    registerSaveHandler(base, createEditorInstanceId("base"), baseSave);
    registerSaveHandler(phase, createEditorInstanceId("phase"), phaseSave);

    await saveDocument(base);
    expect(baseSave).toHaveBeenCalledOnce();
    expect(phaseSave).not.toHaveBeenCalled();

    // Legacy entity flush intentionally drains every variant for that id.
    await saveScene("entry-1");
    expect(baseSave).toHaveBeenCalledTimes(2);
    expect(phaseSave).toHaveBeenCalledOnce();
  });

  it("explicit discard targets only the closing split-view group", () => {
    const key: DocumentKey = { kind: "snippet", id: "snippet-1" };
    const primaryId = createEditorInstanceId("primary");
    const secondaryId = createEditorInstanceId("secondary");
    const primaryDiscard = vi.fn();
    const secondaryDiscard = vi.fn();
    registerDiscardHandler(key, primaryId, primaryDiscard, 0);
    registerDiscardHandler(key, secondaryId, secondaryDiscard, 1);

    discardDocumentInGroup("snippet-1", 0);

    expect(primaryDiscard).toHaveBeenCalledOnce();
    expect(secondaryDiscard).not.toHaveBeenCalled();
    unregisterDiscardHandler(key, primaryId, primaryDiscard);
    unregisterDiscardHandler(key, secondaryId, secondaryDiscard);
  });

  it("一方のpane保存versionを同じ文書のpeerだけへ伝播する", () => {
    const key: DocumentKey = { kind: "snippet", id: "snippet-1" };
    const otherKey: DocumentKey = { kind: "snippet", id: "snippet-2" };
    const firstId = createEditorInstanceId("first");
    const peerId = createEditorInstanceId("peer");
    const otherId = createEditorInstanceId("other");
    const peerGate = createEditorMutationGate();
    const otherGate = createEditorMutationGate();
    const initial: LoadedEditorBinding = {
      kind: "snippet",
      id: "snippet-1",
      loadedVersion: 3,
    };
    peerGate.commitLoad(initial);
    otherGate.commitLoad({
      kind: "snippet",
      id: "snippet-2",
      loadedVersion: 9,
    });
    const peerHandler = (binding: LoadedEditorBinding) => {
      peerGate.advancePeerSave(binding);
    };
    const originHandler = vi.fn();
    const otherHandler = (binding: LoadedEditorBinding) => {
      otherGate.advancePeerSave(binding);
    };
    registerPersistedBindingHandler(key, firstId, originHandler);
    registerPersistedBindingHandler(key, peerId, peerHandler);
    registerPersistedBindingHandler(otherKey, otherId, otherHandler);

    announcePersistedBinding(key, firstId, {
      ...initial,
      loadedVersion: 4,
    });

    expect(peerGate.captureSave()?.binding).toMatchObject({
      id: "snippet-1",
      loadedVersion: 4,
    });
    peerGate.markEdited();
    expect(peerGate.captureSave()?.binding).toMatchObject({
      id: "snippet-1",
      loadedVersion: 4,
    });
    expect(originHandler).not.toHaveBeenCalled();
    expect(otherGate.captureSave()?.binding).toMatchObject({
      id: "snippet-2",
      loadedVersion: 9,
    });

    unregisterPersistedBindingHandler(key, firstId, originHandler);
    unregisterPersistedBindingHandler(key, peerId, peerHandler);
    unregisterPersistedBindingHandler(otherKey, otherId, otherHandler);
  });
});

/**
 * saveScene() の外部 flush 契約は「DB を live editor の状態に追いつかせる」。
 * clean な editor まで無条件保存すると、saveSceneContent の OCC version が
 * flush のたびに bump され、開いているだけのシーンへの headless 自動適用
 * (autoApplyProse の base_version 突き合わせ) が恒久 stale ブロックになる。
 * dirty ゲートで「未保存編集があるときだけ書く」ことを保証する。
 */
describe("dirtyGatedSaveHandler (外部 flush の dirty ゲート)", () => {
  it("dirty のとき save を呼ぶ", async () => {
    const save = vi.fn(async () => {});
    const handler = dirtyGatedSaveHandler(() => true, save);
    await handler();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("clean のとき no-op で resolve する (保存も version bump も走らない)", async () => {
    const save = vi.fn(async () => {});
    const handler = dirtyGatedSaveHandler(() => false, save);
    await expect(handler()).resolves.toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it("dirty は登録時ではなく呼び出し時点で評価する", async () => {
    const save = vi.fn(async () => {});
    let dirty = false;
    const handler = dirtyGatedSaveHandler(() => dirty, save);
    registerSaveHandler("scene-x", handler);
    await saveScene("scene-x");
    expect(save).not.toHaveBeenCalled();
    dirty = true;
    await saveScene("scene-x");
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("save の失敗はそのまま伝播する (呼び出し側が dirty を維持できる)", async () => {
    const save = vi.fn(async () => {
      throw new Error("boom");
    });
    const handler = dirtyGatedSaveHandler(() => true, save);
    await expect(handler()).rejects.toThrow("boom");
  });
});

describe("エディタの save handler 登録 (ソース invariant)", () => {
  // EditorPane / LinearSceneBlock はコンポーネントテスト基盤の無い巨大
  // コンポーネントなので、EditorPane.snippetSave.test.ts と同じく
  // レンダリングせず構造 invariant として gate する。素の saveFn を直接
  // 登録し直すと dirty ゲートが外れて上記の恒久 stale ブロックが再発する。
  it("EditorPane は dirtyGatedSaveHandler 経由で登録する", () => {
    const src = readFileSync(resolve(__dirname, "./EditorPane.tsx"), "utf-8");
    expect(src).toMatch(/dirtyGatedSaveHandler\(/);
    expect(src).not.toMatch(/registerSaveHandler\(nodeId, saveFn\)/);
  });

  it("LinearSceneBlock は dirtyGatedSaveHandler 経由で登録する", () => {
    const src = readFileSync(
      resolve(__dirname, "./LinearSceneBlock.tsx"),
      "utf-8",
    );
    expect(src).toMatch(/dirtyGatedSaveHandler\(/);
    expect(src).not.toMatch(/registerSaveHandler\(sceneId, saveFn\)/);
  });

  it("EditorPane は inline-AI 非 idle 遷移で armed autosave を cancel する", () => {
    // onUpdate の gate は「新規 schedule の抑止」のみで、arm 済みタイマーは
    // 発火して未 accept のプレビュー/生成テキストごと persist してしまう
    // (無帰属 AI テキストの焼き込み)。owner 一致の非 idle 遷移で cancel する
    // こと (挙動テストは LinearSceneBlock 側、こちらはソース invariant)。
    const src = readFileSync(resolve(__dirname, "./EditorPane.tsx"), "utf-8");
    expect(src).toMatch(
      /inlineAiStatus !== "idle" && inlineAiOwnerEditor === editor[\s\S]{0,120}?cancel\(\)/,
    );
  });
});
