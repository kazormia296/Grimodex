// @vitest-environment happy-dom
// 利用方針が壊れた作品で、実物の門と書き込みの処理を通ると、会話の画面の行には
// 確認済みの文が、モデルには固定の英語が返る。
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/lib/tauri", () => ({ invoke }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import i18next, { ensureLocale } from "@/lib/i18n";
import { useProjectStore } from "@/features/project/projectStore";
import { executeTool } from "./toolExecutors";

const damaged = "AI ポリシーが壊れているため、書き込みを停止しました";

beforeAll(async () => {
  await ensureLocale("ja");
  await i18next.changeLanguage("ja");
});

beforeEach(() => {
  invoke.mockReset();
  useProjectStore.setState({
    currentProjectId: "p1",
    projects: [{ id: "p1", aiPolicy: "not-json" } as never],
  });
});

describe("agent write tools on a damaged AI policy", () => {
  it.each([
    ["create_snippet", { title: "覚え書き" }, "knowledgeWrite"],
    ["create_foreshadow", { title: "伏線" }, "knowledgeWrite"],
    ["propose_scene_body", { sceneId: "s1", text: "本文" }, "bodyWrite"],
    [
      "create_event",
      {
        title: "出来事",
        startTime: 0,
        startGranularity: "day",
        precision: "exact",
      },
      "knowledgeWrite",
    ],
  ])(
    "%s shows the stop reason on its row and writes nothing",
    async (name, params, feature) => {
      const result = await executeTool(name, "call-1", params);
      expect(result.summary).toBe(damaged);
      expect(result.error).toBe(`${feature} policy is off`);
      expect(invoke).not.toHaveBeenCalled();
    },
  );
});
