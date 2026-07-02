// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";

// リニアモード解除時の本文消失バグの回帰テスト。
// unmount cleanup からの autosave flush は await されない (fire-and-forget) ため、
// 直後に mount する EditorPane の loadSceneFull / LinearSceneBlock の
// loadSceneContent が UPDATE を追い越して編集前の行を読み、stale 表示
// → 次の autosave で stale が DB を上書き = 実データ消失になっていた。
// saveSceneContent が pending write を同期 track し、load 系が読む前に
// それを待つこと (read-after-write バリア) を db モックの実行順で検証する。

const state = vi.hoisted(() => ({
  events: [] as string[],
  resolveUpdate: undefined as (() => void) | undefined,
  rejectUpdate: undefined as ((e: unknown) => void) | undefined,
  rows: [] as Record<string, unknown>[],
}));

vi.mock("@/db/client", () => ({
  db: {
    update: () => ({
      set: () => ({
        where: () => {
          state.events.push("update:dispatched");
          return new Promise<void>((res, rej) => {
            state.resolveUpdate = () => {
              state.events.push("update:resolved");
              res();
            };
            state.rejectUpdate = rej;
          });
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => {
          state.events.push("select:executed");
          return Promise.resolve(state.rows);
        },
      }),
    }),
  },
}));

import {
  saveSceneContent,
  loadSceneContent,
  loadSceneFull,
  loadScenesFull,
  loadSceneContents,
} from "./api";

const DOC = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "リニアモードで書いた本文" }],
    },
  ],
});

/** マクロタスク 1 周分。pending 中の continuation を全部流す。 */
function flushTasks() {
  return new Promise<void>((r) => setTimeout(r, 0));
}

beforeEach(() => {
  state.events = [];
  state.resolveUpdate = undefined;
  state.rejectUpdate = undefined;
  state.rows = [{ content: DOC, unplacedBeatsDoc: "[]" }];
});

describe("scene content の read-after-write バリア", () => {
  it("loadSceneContent は await されていない saveSceneContent を追い越さない", async () => {
    // fire-and-forget (unmount cleanup の flush と同じ呼び方)
    const save = saveSceneContent("s1", DOC);
    // 同期直後に read (EditorPane mount の load と同じタイミング)
    const load = loadSceneContent("s1");

    await flushTasks();
    expect(state.events).toContain("update:dispatched");
    expect(state.events).not.toContain("select:executed");

    state.resolveUpdate!();
    await expect(load).resolves.toBe(DOC);
    expect(state.events).toEqual([
      "update:dispatched",
      "update:resolved",
      "select:executed",
    ]);
    await save;
  });

  it("loadSceneFull も同じバリアで待つ", async () => {
    const save = saveSceneContent("s1", DOC);
    const load = loadSceneFull("s1");

    await flushTasks();
    expect(state.events).not.toContain("select:executed");

    state.resolveUpdate!();
    const result = await load;
    expect(result.content).toBe(DOC);
    expect(state.events.indexOf("select:executed")).toBeGreaterThan(
      state.events.indexOf("update:resolved"),
    );
    await save;
  });

  it("loadScenesFull (バッチ版) も同じバリアで待つ", async () => {
    state.rows = [{ id: "s1", content: DOC, unplacedBeatsDoc: "[]" }];
    const save = saveSceneContent("s1", DOC);
    const load = loadScenesFull(["s1", "s2"]);

    await flushTasks();
    expect(state.events).not.toContain("select:executed");

    state.resolveUpdate!();
    const result = await load;
    expect(result.get("s1")?.content).toBe(DOC);
    expect(state.events.indexOf("select:executed")).toBeGreaterThan(
      state.events.indexOf("update:resolved"),
    );
    await save;
  });

  it("loadSceneContents (content 専用バッチ版) も同じバリアで待つ", async () => {
    state.rows = [{ id: "s1", content: DOC }];
    const save = saveSceneContent("s1", DOC);
    const load = loadSceneContents(["s1", "s2"]);

    await flushTasks();
    expect(state.events).not.toContain("select:executed");

    state.resolveUpdate!();
    const result = await load;
    expect(result.get("s1")).toBe(DOC);
    expect(state.events.indexOf("select:executed")).toBeGreaterThan(
      state.events.indexOf("update:resolved"),
    );
    await save;
  });

  it("write が失敗しても read はブロックされず最後の commit 済み行を返す", async () => {
    const save = saveSceneContent("s1", DOC).catch(() => {});
    const load = loadSceneContent("s1");

    state.rejectUpdate!(new Error("ipc failed"));
    await expect(load).resolves.toBe(DOC);
    await save;
  });

  it("別シーンの pending write では読み取りをブロックしない", async () => {
    const save = saveSceneContent("other-scene", DOC);
    const load = loadSceneContent("s1");

    await flushTasks();
    // s1 の select は other-scene の UPDATE 解決を待たずに実行される
    expect(state.events).toContain("select:executed");

    state.resolveUpdate!();
    await Promise.all([save, load]);
  });
});
