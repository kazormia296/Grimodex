// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useSemanticNavStore } from "@/features/semantic-search/semanticNavStore";
import type { RelatedScene } from "./selectRelatedScenes";
import type { Nir1RelatedScenesFetchResult } from "./nir1RelatedScenesFetchTypes";
import type { Nir1RelatedScenesSession } from "./nir1RelatedScenesSession";

vi.mock("./fetchRelatedScenes", () => ({
  fetchRelatedPastScenes: vi.fn(),
  RELATED_SCENES_MAX: 8,
  RELATED_SCENES_FETCH_LIMIT: 30,
}));

vi.mock("./nir1RelatedScenesApi", () => ({
  listenRelatedScenesIndexReady: vi.fn(async () => () => {}),
  qualifyNir1Evidence: vi.fn(),
}));

import { fetchRelatedPastScenes } from "./fetchRelatedScenes";
import { RelatedScenesSection } from "./RelatedScenesSection";

const mockFetch = vi.mocked(fetchRelatedPastScenes);

function rawResult(scenes: RelatedScene[]): Nir1RelatedScenesFetchResult {
  return {
    status: "completed",
    rawStatus: "completed",
    origin: null,
    queryBinding: "binding",
    initialSnapshot: null,
    completion: null,
    rawScenes: scenes,
    result: { kind: "raw", scenes, ir: { status: "empty" } },
    session: null,
    timing: { tFetchMs: 0, tRawReadyMs: 1, tReturnMs: 1 },
  };
}

function setActive(id: string) {
  useTreeStore.setState({ activeSceneId: id });
}

/** 存在ガード用に tree に最小ノードを積む (navigateToScene は n.id だけ見る)。 */
function seedNodes(ids: string[]) {
  useTreeStore.setState({ nodes: ids.map((id) => ({ id })) } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  useSemanticNavStore.setState({ pendingJump: null });
  seedNodes([]);
  setActive("");
});

afterEach(() => {
  cleanup();
});

describe("RelatedScenesSection", () => {
  it("アクティブシーンが無いときは検索せず、行を出さない", async () => {
    setActive("");
    render(<RelatedScenesSection enabled />);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.queryAllByTestId("related-scene-row")).toHaveLength(0);
  });

  it("無効 (enabled=false) のときは検索しない", () => {
    setActive("s2");
    render(<RelatedScenesSection enabled={false} />);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("関連過去シーンを行として描画し、スコアを%表示する", async () => {
    const scenes: RelatedScene[] = [
      {
        sceneId: "s1",
        sceneTitle: "井戸端の密談",
        chunkText: "エリカが鍵を渡した場面",
        score: 0.92,
      },
    ];
    mockFetch.mockResolvedValue(rawResult(scenes));
    setActive("s2");
    render(<RelatedScenesSection enabled />);

    await waitFor(() => {
      expect(screen.getByText("井戸端の密談")).toBeTruthy();
    });
    expect(mockFetch).toHaveBeenCalledWith(
      "s2",
      expect.objectContaining({ mode: "hybrid" }),
    );
    expect(screen.getByText("92%")).toBeTruthy();
    expect(screen.getByText("エリカが鍵を渡した場面")).toBeTruthy();
  });

  it("折りたたむ (見出しクリック) と検索が止まり行が消える", async () => {
    const scenes: RelatedScene[] = [
      {
        sceneId: "s1",
        sceneTitle: "井戸端の密談",
        chunkText: "エリカが鍵を渡した場面",
        score: 0.92,
      },
    ];
    mockFetch.mockResolvedValue(rawResult(scenes));
    setActive("s2");
    render(<RelatedScenesSection enabled />);

    const row = await screen.findByText("井戸端の密談");
    expect(row).toBeTruthy();

    // 見出し(aria-expanded ボタン)をクリックして折りたたむ
    const header = screen.getByRole("button", { expanded: true });
    fireEvent.click(header);

    await waitFor(() => {
      expect(screen.queryAllByTestId("related-scene-row")).toHaveLength(0);
    });
  });

  it("行クリックで requestJump + setActiveScene が走る (ジャンプ配線)", async () => {
    const scenes: RelatedScene[] = [
      {
        sceneId: "s1",
        sceneTitle: "井戸端の密談",
        chunkText: "エリカが鍵を渡した場面",
        score: 0.92,
      },
    ];
    mockFetch.mockResolvedValue(rawResult(scenes));
    seedNodes(["s1", "s2"]);
    setActive("s2");
    render(<RelatedScenesSection enabled />);

    const row = await screen.findByText("井戸端の密談");
    fireEvent.click(row);

    expect(useSemanticNavStore.getState().pendingJump).toEqual({
      sceneId: "s1",
      chunkText: "エリカが鍵を渡した場面",
    });
    expect(useTreeStore.getState().activeSceneId).toBe("s1");
  });

  it("削除済みシーン (tree に無い) の行クリックではジャンプしない", async () => {
    const scenes: RelatedScene[] = [
      {
        sceneId: "deleted",
        sceneTitle: "消えた章",
        chunkText: "もう存在しない本文",
        score: 0.9,
      },
    ];
    mockFetch.mockResolvedValue(rawResult(scenes));
    seedNodes(["s2"]); // "deleted" は tree に無い
    setActive("s2");
    render(<RelatedScenesSection enabled />);

    const row = await screen.findByText("消えた章");
    fireEvent.click(row);

    expect(useSemanticNavStore.getState().pendingJump).toBeNull();
    expect(useTreeStore.getState().activeSceneId).toBe("s2");
  });
});

describe("NIR interpretation display", () => {
  it("keeps Raw excerpt separate, shows full modality and never labels RRF as cosine percent", async () => {
    const raw = {
      sceneId: "s1",
      sceneTitle: "Bridge",
      chunkText: "Original prose",
      score: 0.92,
    };
    const result = rawResult([raw]);
    const ir = {
      sceneId: "s1",
      sceneTitle: "Bridge",
      irCosine: 0.91,
      interpretation: {
        summary: "The bridge may have fallen",
        actuality: "rumored",
        attribution: "the guard",
        narrativeFrame: "reported speech",
      },
      validatedEvidence: {
        excerpt: "Only verified evidence",
        navigationIdentity: "opaque",
      },
      review: "human-approved" as const,
      freshness: "fresh" as const,
    };
    mockFetch.mockResolvedValue({
      ...result,
      result: {
        kind: "fused",
        ir: { status: "available" },
        scenes: [
          {
            kind: "raw-ir",
            sceneId: "s1",
            sceneTitle: "Bridge",
            rank1: 1,
            raw,
            ir,
          },
        ],
      },
    });
    setActive("s2");
    render(<RelatedScenesSection />);
    await screen.findByText("The bridge may have fallen");
    expect(screen.getByText("Original prose")).toBeTruthy();
    expect(screen.getByText("rumored")).toBeTruthy();
    expect(screen.getByText("the guard")).toBeTruthy();
    expect(screen.getByText("reported speech")).toBeTruthy();
    expect(screen.getByTestId("nir1-evidence-link").textContent).toContain(
      "Only verified evidence",
    );
    expect(screen.queryByText("3%")).toBeNull();
    expect(screen.queryByText("92%")).toBeNull();
  });

  it("distinguishes unavailable IR from empty search and releases the displayed owner on collapse", async () => {
    const release = vi.fn();
    const value = rawResult([]);
    mockFetch.mockResolvedValue({
      ...value,
      result: {
        kind: "raw",
        scenes: [],
        ir: { status: "unavailable", reason: "index-unavailable" },
      },
      session: {
        release,
        subscribeInvalidation: () => () => {},
      } as unknown as Nir1RelatedScenesSession,
    });
    setActive("s2");
    render(<RelatedScenesSection />);
    expect(await screen.findByTestId("nir1-unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    await waitFor(() => expect(release).toHaveBeenCalledOnce());
  });
});
