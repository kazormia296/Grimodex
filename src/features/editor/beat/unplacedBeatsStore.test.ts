import { describe, it, expect, beforeEach, vi } from "vitest";
import { useUnplacedBeatsStore } from "./unplacedBeatsStore";
import type { UnplacedBeat } from "./unplacedBeatsStore";

function makeBeat(id: string, text = "test"): UnplacedBeat {
  return {
    id,
    beatType: "free",
    pov: null,
    collapsed: false,
    content: [{ type: "text", text }],
  };
}

beforeEach(() => {
  useUnplacedBeatsStore.getState().resetForProject();
});

describe("unplacedBeatsStore", () => {
  describe("resetForProject", () => {
    it("same sceneId の旧 scope cache と subscriber を無通知で破棄する", () => {
      const oldScopeSubscriber = vi.fn();
      useUnplacedBeatsStore
        .getState()
        .subscribe("shared-scene-id", oldScopeSubscriber);
      useUnplacedBeatsStore
        .getState()
        .setBeats("shared-scene-id", [makeBeat("old-workspace-beat")], "load");

      useUnplacedBeatsStore.getState().resetForProject();

      expect(
        useUnplacedBeatsStore.getState().getBeats("shared-scene-id"),
      ).toEqual([]);
      expect(oldScopeSubscriber).not.toHaveBeenCalled();

      useUnplacedBeatsStore
        .getState()
        .setBeats("shared-scene-id", [makeBeat("new-workspace-beat")], "user");
      expect(oldScopeSubscriber).not.toHaveBeenCalled();
      expect(
        useUnplacedBeatsStore
          .getState()
          .getBeats("shared-scene-id")
          .map((beat) => beat.id),
      ).toEqual(["new-workspace-beat"]);
    });
  });

  describe("getBeats", () => {
    it("存在しないシーンは空配列を返す", () => {
      expect(useUnplacedBeatsStore.getState().getBeats("unknown")).toEqual([]);
    });

    it("setBeats後にgetBeatsで取得できる", () => {
      const beats = [makeBeat("b1"), makeBeat("b2")];
      useUnplacedBeatsStore.getState().setBeats("s1", beats, "load");
      expect(useUnplacedBeatsStore.getState().getBeats("s1")).toEqual(beats);
    });
  });

  describe("setBeats", () => {
    it("source=load のとき subscriber に通知しない", () => {
      const cb = vi.fn();
      useUnplacedBeatsStore.getState().subscribe("s1", cb);
      useUnplacedBeatsStore.getState().setBeats("s1", [makeBeat("b1")], "load");
      expect(cb).not.toHaveBeenCalled();
    });

    it("source=user のとき subscriber に通知する", () => {
      const cb = vi.fn();
      useUnplacedBeatsStore.getState().subscribe("s1", cb);
      useUnplacedBeatsStore.getState().setBeats("s1", [makeBeat("b1")], "user");
      expect(cb).toHaveBeenCalledOnce();
    });

    it("sourceを省略すると user 扱いで通知する", () => {
      const cb = vi.fn();
      useUnplacedBeatsStore.getState().subscribe("s1", cb);
      useUnplacedBeatsStore.getState().setBeats("s1", [makeBeat("b1")]);
      expect(cb).toHaveBeenCalledOnce();
    });
  });

  describe("addBeat", () => {
    it("配列末尾にビートを追加する", () => {
      useUnplacedBeatsStore.getState().setBeats("s1", [makeBeat("b1")], "load");
      useUnplacedBeatsStore.getState().addBeat("s1", makeBeat("b2"));
      const beats = useUnplacedBeatsStore.getState().getBeats("s1");
      expect(beats).toHaveLength(2);
      expect(beats[1].id).toBe("b2");
    });

    it("subscriber に通知する", () => {
      const cb = vi.fn();
      useUnplacedBeatsStore.getState().subscribe("s1", cb);
      useUnplacedBeatsStore.getState().addBeat("s1", makeBeat("b1"));
      expect(cb).toHaveBeenCalledOnce();
    });
  });

  describe("removeBeat", () => {
    it("指定IDのビートを削除する", () => {
      useUnplacedBeatsStore
        .getState()
        .setBeats("s1", [makeBeat("b1"), makeBeat("b2")], "load");
      useUnplacedBeatsStore.getState().removeBeat("s1", "b1");
      const beats = useUnplacedBeatsStore.getState().getBeats("s1");
      expect(beats).toHaveLength(1);
      expect(beats[0].id).toBe("b2");
    });

    it("存在しないIDの削除は配列を変えない", () => {
      useUnplacedBeatsStore.getState().setBeats("s1", [makeBeat("b1")], "load");
      useUnplacedBeatsStore.getState().removeBeat("s1", "nonexistent");
      expect(useUnplacedBeatsStore.getState().getBeats("s1")).toHaveLength(1);
    });

    it("subscriber に通知する", () => {
      useUnplacedBeatsStore.getState().setBeats("s1", [makeBeat("b1")], "load");
      const cb = vi.fn();
      useUnplacedBeatsStore.getState().subscribe("s1", cb);
      useUnplacedBeatsStore.getState().removeBeat("s1", "b1");
      expect(cb).toHaveBeenCalledOnce();
    });
  });

  describe("updateBeat", () => {
    it("指定IDのビートを部分更新する", () => {
      useUnplacedBeatsStore.getState().setBeats("s1", [makeBeat("b1")], "load");
      useUnplacedBeatsStore
        .getState()
        .updateBeat("s1", "b1", { beatType: "dialogue" });
      const beat = useUnplacedBeatsStore.getState().getBeats("s1")[0];
      expect(beat.beatType).toBe("dialogue");
      expect(beat.id).toBe("b1"); // 他フィールドは保持
    });

    it("subscriber に通知する", () => {
      useUnplacedBeatsStore.getState().setBeats("s1", [makeBeat("b1")], "load");
      const cb = vi.fn();
      useUnplacedBeatsStore.getState().subscribe("s1", cb);
      useUnplacedBeatsStore
        .getState()
        .updateBeat("s1", "b1", { collapsed: true });
      expect(cb).toHaveBeenCalledOnce();
    });
  });

  describe("reorder", () => {
    it("fromIdx から toIdx へ要素を移動する", () => {
      useUnplacedBeatsStore
        .getState()
        .setBeats(
          "s1",
          [makeBeat("b1"), makeBeat("b2"), makeBeat("b3")],
          "load",
        );
      useUnplacedBeatsStore.getState().reorder("s1", 0, 2);
      const ids = useUnplacedBeatsStore
        .getState()
        .getBeats("s1")
        .map((b) => b.id);
      expect(ids).toEqual(["b2", "b3", "b1"]);
    });

    it("範囲外インデックスでもクラッシュしない", () => {
      useUnplacedBeatsStore.getState().setBeats("s1", [makeBeat("b1")], "load");
      expect(() =>
        useUnplacedBeatsStore.getState().reorder("s1", 0, 5),
      ).not.toThrow();
    });

    it("subscriber に通知する", () => {
      useUnplacedBeatsStore
        .getState()
        .setBeats("s1", [makeBeat("b1"), makeBeat("b2")], "load");
      const cb = vi.fn();
      useUnplacedBeatsStore.getState().subscribe("s1", cb);
      useUnplacedBeatsStore.getState().reorder("s1", 0, 1);
      expect(cb).toHaveBeenCalledOnce();
    });
  });

  describe("subscribe", () => {
    it("unsubscribe 後は通知されない", () => {
      const cb = vi.fn();
      const unsub = useUnplacedBeatsStore.getState().subscribe("s1", cb);
      unsub();
      useUnplacedBeatsStore.getState().addBeat("s1", makeBeat("b1"));
      expect(cb).not.toHaveBeenCalled();
    });

    it("異なるシーンの更新は通知されない", () => {
      const cb = vi.fn();
      useUnplacedBeatsStore.getState().subscribe("s1", cb);
      useUnplacedBeatsStore.getState().addBeat("s2", makeBeat("b1"));
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe("clearScene", () => {
    it("シーンのデータを削除する", () => {
      useUnplacedBeatsStore.getState().setBeats("s1", [makeBeat("b1")], "load");
      useUnplacedBeatsStore.getState().clearScene("s1");
      expect(useUnplacedBeatsStore.getState().getBeats("s1")).toEqual([]);
    });
  });
});
