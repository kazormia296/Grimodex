import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  registerSaveHandler,
  unregisterSaveHandler,
  saveScene,
  registeredSaveHandlerIds,
  dirtyGatedSaveHandler,
} from "./editorSaveRegistry";

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

  it("EditorPane は save 中に入った編集の dirty を世代カウンタでクロバーしない", () => {
    // coreSave の await 中に入った編集の dirty=true を、保存完了時の無条件
    // setIsDirty(false) が消すと gate が clean 誤判定 → headless 適用の
    // resync が未保存編集を上書きする。dirty クリアは「save 開始時と編集
    // 世代が一致する場合のみ」であること (挙動テストは LinearSceneBlock 側、
    // EditorPane はコンポーネントテスト基盤が無いためソース invariant)。
    const src = readFileSync(resolve(__dirname, "./EditorPane.tsx"), "utf-8");
    expect(src).toMatch(/const editGenAtStart = editGenerationRef\.current/);
    expect(src).toMatch(
      /if \(editGenerationRef\.current === editGenAtStart\)[\s\S]{0,300}?setIsDirtyRef\.current\(false\)/,
    );
  });
});
