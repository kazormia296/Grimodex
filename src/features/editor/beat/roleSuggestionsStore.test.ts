import { describe, it, expect, beforeEach } from "vitest";
import { useRoleSuggestionsStore } from "./roleSuggestionsStore";
import type { RoleSuggestionEntry } from "./roleSuggestionsStore";

function makeEntry(
  codexId: string,
  suggestedRole: RoleSuggestionEntry["suggestedRole"] = "actor",
  confidence = 0.8,
): RoleSuggestionEntry {
  return {
    codexId,
    name: `name-${codexId}`,
    currentRole: "mentioned",
    suggestedRole,
    confidence,
    status: "pending",
  };
}

beforeEach(() => {
  useRoleSuggestionsStore.setState({ byBeatId: {} });
});

describe("roleSuggestionsStore", () => {
  describe("setSuggestions", () => {
    it("beat id に対して提案リストを格納する", () => {
      const entries = [makeEntry("c1"), makeEntry("c2", "target", 0.7)];
      useRoleSuggestionsStore.getState().setSuggestions("b1", entries);
      const stored = useRoleSuggestionsStore.getState().byBeatId["b1"];
      expect(stored).toHaveLength(2);
    });

    it("confidence 降順でソートして格納する", () => {
      const entries = [
        makeEntry("c1", "actor", 0.5),
        makeEntry("c2", "target", 0.9),
        makeEntry("c3", "mentioned", 0.7),
      ];
      useRoleSuggestionsStore.getState().setSuggestions("b1", entries);
      const stored = useRoleSuggestionsStore.getState().byBeatId["b1"];
      expect(stored[0].codexId).toBe("c2"); // 0.9
      expect(stored[1].codexId).toBe("c3"); // 0.7
      expect(stored[2].codexId).toBe("c1"); // 0.5
    });

    it("既存のエントリを上書きする", () => {
      useRoleSuggestionsStore
        .getState()
        .setSuggestions("b1", [makeEntry("c1")]);
      useRoleSuggestionsStore
        .getState()
        .setSuggestions("b1", [makeEntry("c2")]);
      const stored = useRoleSuggestionsStore.getState().byBeatId["b1"];
      expect(stored).toHaveLength(1);
      expect(stored[0].codexId).toBe("c2");
    });
  });

  describe("getActive", () => {
    it("status=pending のエントリのみ返す", () => {
      useRoleSuggestionsStore
        .getState()
        .setSuggestions("b1", [makeEntry("c1"), makeEntry("c2")]);
      useRoleSuggestionsStore.getState().markStatus("b1", "c1", "accepted");
      const active = useRoleSuggestionsStore.getState().getActive("b1");
      expect(active).toHaveLength(1);
      expect(active[0].codexId).toBe("c2");
    });

    it("rejected も除外する", () => {
      useRoleSuggestionsStore
        .getState()
        .setSuggestions("b1", [makeEntry("c1"), makeEntry("c2")]);
      useRoleSuggestionsStore.getState().markStatus("b1", "c2", "rejected");
      const active = useRoleSuggestionsStore.getState().getActive("b1");
      expect(active).toHaveLength(1);
      expect(active[0].codexId).toBe("c1");
    });

    it("存在しない beatId は空配列を返す", () => {
      expect(
        useRoleSuggestionsStore.getState().getActive("nonexistent"),
      ).toEqual([]);
    });
  });

  describe("markStatus", () => {
    it("指定した codexId の status を更新する", () => {
      useRoleSuggestionsStore
        .getState()
        .setSuggestions("b1", [makeEntry("c1"), makeEntry("c2")]);
      useRoleSuggestionsStore.getState().markStatus("b1", "c1", "accepted");
      const stored = useRoleSuggestionsStore.getState().byBeatId["b1"];
      expect(stored.find((e) => e.codexId === "c1")?.status).toBe("accepted");
      expect(stored.find((e) => e.codexId === "c2")?.status).toBe("pending");
    });

    it("存在しない beatId への操作はクラッシュしない", () => {
      expect(() =>
        useRoleSuggestionsStore.getState().markStatus("none", "c1", "accepted"),
      ).not.toThrow();
    });
  });

  describe("clearBeat", () => {
    it("指定 beatId のエントリを削除する", () => {
      useRoleSuggestionsStore
        .getState()
        .setSuggestions("b1", [makeEntry("c1")]);
      useRoleSuggestionsStore
        .getState()
        .setSuggestions("b2", [makeEntry("c2")]);
      useRoleSuggestionsStore.getState().clearBeat("b1");
      expect(useRoleSuggestionsStore.getState().byBeatId["b1"]).toBeUndefined();
      expect(useRoleSuggestionsStore.getState().byBeatId["b2"]).toHaveLength(1);
    });

    it("存在しない beatId への操作はクラッシュしない", () => {
      expect(() =>
        useRoleSuggestionsStore.getState().clearBeat("none"),
      ).not.toThrow();
    });
  });
});
