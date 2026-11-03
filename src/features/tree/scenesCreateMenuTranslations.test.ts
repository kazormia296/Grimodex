import { describe, expect, it } from "vitest";
import en from "@/locales/en.json";
import ja from "@/locales/ja.json";

// Scenes の「+」メニュー（ScenesToolbar の CREATE_OPTIONS）の項目。
describe("Scenes create menu translations", () => {
  it("are translated in Japanese", () => {
    expect(ja.scenes.newScene).toBe("新しいシーン");
    expect(ja.scenes.newNote).toBe("新しいノート");
    expect(ja.scenes.newFolder).toBe("新しいフォルダー");
    for (const key of ["newScene", "newNote", "newFolder"] as const) {
      expect(ja.scenes[key]).not.toBe(en.scenes[key]);
    }
  });
});
