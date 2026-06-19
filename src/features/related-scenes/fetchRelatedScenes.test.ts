import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import type { SemanticSearchHit } from "@/features/semantic-search/api";

// fetchRelatedScenes は IPC / ストアに依存するので、外部副作用だけモックし、
// 順序計算 (computeSceneTimeIndex) と選別 (selectRelatedPastScenes) は実物を走らせる。
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("@/features/tree/api", () => ({
  loadSceneContent: vi.fn(async () =>
    JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "本文テキスト本文テキスト" }],
        },
      ],
    }),
  ),
}));
vi.mock("@/features/semantic-search/api", () => ({
  semanticSearch: vi.fn(),
}));
// sparse 腕 (FTS5) は invoke を叩くのでモック。閾値・クエリ系は実物を使う。
vi.mock("@/features/chat/semanticRecall", async (orig) => ({
  ...(await orig<typeof import("@/features/chat/semanticRecall")>()),
  fetchSparseSceneIds: vi.fn(async () => [] as string[]),
}));

import { semanticSearch } from "@/features/semantic-search/api";
import { fetchRelatedPastScenes } from "./fetchRelatedScenes";

const mockSearch = vi.mocked(semanticSearch);

function hit(sceneId: string, score: number): SemanticSearchHit {
  return {
    sceneId,
    sceneTitle: `title-${sceneId}`,
    chunkText: `chunk-${sceneId}`,
    charStart: 0,
    charEnd: 10,
    score,
    dialogueRatio: 0,
  };
}

/**
 * 読書順と作中時系列が食い違うツリーを積む。
 * 読書順 (sortOrder): A < B(current) < C
 * 作中時系列 (storyTimeOrder): A < C < B  ← C は「後で読むが作中では B より前」の回想
 */
function seedFlashbackTree() {
  const nodes = [
    {
      id: "A",
      projectId: "p1",
      parentId: null,
      nodeType: "scene",
      sortOrder: "a",
      storyTimeOrder: "a",
    },
    {
      id: "B",
      projectId: "p1",
      parentId: null,
      nodeType: "scene",
      sortOrder: "b",
      storyTimeOrder: "c",
    },
    {
      id: "C",
      projectId: "p1",
      parentId: null,
      nodeType: "scene",
      sortOrder: "c",
      storyTimeOrder: "b",
    },
  ];
  useTreeStore.setState({ nodes } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  seedFlashbackTree();
  // 全シーンが ja gate(0.85) 以上で confident。B は current で除外される。
  mockSearch.mockResolvedValue([hit("A", 0.9), hit("B", 0.95), hit("C", 0.88)]);
});

describe("fetchRelatedPastScenes — 順序軸は phase_resolution_mode に従う", () => {
  it("reading モード: 読書順で前のシーンだけ (回想 C は読書順で後 = 未読 → 除外)", async () => {
    usePhaseStore.setState({ resolutionMode: "reading" });
    const result = await fetchRelatedPastScenes("B");
    expect(result.map((r) => r.sceneId)).toEqual(["A"]);
  });

  it("story モード: 作中時系列で前のシーンを出す (回想 C は作中で B より前 → 含む)", async () => {
    usePhaseStore.setState({ resolutionMode: "story" });
    const result = await fetchRelatedPastScenes("B");
    // 作中時系列: A < C < B。current=B より前は A と C。
    expect(result.map((r) => r.sceneId).sort()).toEqual(["A", "C"]);
  });
});
