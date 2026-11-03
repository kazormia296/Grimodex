import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTreeStore } from "@/features/tree/treeStore";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { useCodexStore } from "@/features/codex/codexStore";
import type { CodexMatchRow } from "@/features/codex/codexMatchTargets";
import type { SemanticSearchHit } from "@/features/semantic-search/api";

const lang = vi.hoisted(() => ({ value: "ja" }));

// fetchRelatedScenes は IPC / ストアに依存するので、外部副作用だけモックし、
// 順序計算 (computeSceneTimeIndex) と選別 (selectRelatedPastScenes) は実物を走らせる。
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
  getCurrentProjectLanguage: () => lang.value,
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
import { loadSceneContent } from "@/features/tree/api";
import {
  buildSemanticRecallQuery,
  fetchSparseSceneIds,
} from "@/features/chat/semanticRecall";
import { prosemirrorToText } from "@/lib/prosemirror";
import { fetchRelatedPastScenes } from "./fetchRelatedScenes";
import { buildSparseQuery } from "./seedTerms";

const mockSearch = vi.mocked(semanticSearch);
const mockSparse = vi.mocked(fetchSparseSceneIds);
const mockLoad = vi.mocked(loadSceneContent);

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
  lang.value = "ja";
  useCodexStore.setState({ completionTargets: [] });
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

// 設計 §6.2：sparse 腕（fts_search）に渡る query。日本語は Codex の言及とルビで組み、
// 英語と「3 字以上の語が無い」日本語は従来の buildSparseQuery の文字列のまま。どれも 1 回だけ呼ぶ。
describe("fetchRelatedPastScenes — sparse の query", () => {
  const codexRow = (
    id: string,
    name: string,
    aliases: string[] = [],
  ): CodexMatchRow => ({
    id,
    name,
    type: "character",
    aliases: JSON.stringify(aliases),
    excludedAliases: "[]",
  });
  const rubyDoc = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "ruby", attrs: { base: "長谷部", annotation: "はせべ" } },
          { type: "text", text: "は千尋とアリアナを見た。" },
        ],
      },
    ],
  });
  const tailOf = (json: string) =>
    buildSemanticRecallQuery({
      userMessage: "",
      sceneBody: prosemirrorToText(json),
    });

  it("日本語：Codex（ルビの言及・別名の言及）とカタカナの seed だけで組み、1 回だけ呼ぶ", async () => {
    mockLoad.mockResolvedValueOnce(rubyDoc);
    useCodexStore.setState({
      completionTargets: [
        codexRow("e1", "長谷部"),
        codexRow("e2", "藤原千尋", ["千尋"]),
      ],
    });
    await fetchRelatedPastScenes("B");
    expect(mockSparse).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      query: "長谷部 藤原千尋 アリアナ",
    });
    // dense は tail のまま。
    expect(mockSearch.mock.calls[0][0].query).toBe(tailOf(rubyDoc));
  });

  it("日本語で Codex が空・3 字以上の語も無いときは従来の query で 1 回呼ぶ", async () => {
    await fetchRelatedPastScenes("B");
    expect(mockSparse).toHaveBeenCalledOnce();
    // 既定の本文「本文テキスト本文テキスト」はカタカナ「テキスト」が残るので、それだけになる。
    expect(mockSparse.mock.calls[0][0].query).toBe("テキスト");

    vi.clearAllMocks();
    mockSearch.mockResolvedValue([]);
    const plain = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "あめがふる。" }],
        },
      ],
    });
    mockLoad.mockResolvedValueOnce(plain);
    await fetchRelatedPastScenes("B");
    expect(mockSparse).toHaveBeenCalledOnce();
    expect(mockSparse.mock.calls[0][0].query).toBe(
      buildSparseQuery(tailOf(plain), prosemirrorToText(plain)),
    );
  });

  it("英語：Codex があっても従来の buildSparseQuery の文字列", async () => {
    lang.value = "en";
    mockLoad.mockResolvedValueOnce(rubyDoc);
    useCodexStore.setState({ completionTargets: [codexRow("e1", "長谷部")] });
    await fetchRelatedPastScenes("B");
    expect(mockSparse).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      query: buildSparseQuery(tailOf(rubyDoc), prosemirrorToText(rubyDoc)),
    });
  });
});
