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

vi.mock("./fetchRelatedScenes", () => ({
  fetchRelatedPastScenes: vi.fn(),
  RELATED_SCENES_MAX: 8,
  RELATED_SCENES_FETCH_LIMIT: 30,
}));

import { fetchRelatedPastScenes } from "./fetchRelatedScenes";
import { RelatedScenesPanel } from "./RelatedScenesPanel";

const mockFetch = vi.mocked(fetchRelatedPastScenes);

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

describe("RelatedScenesPanel", () => {
  it("アクティブシーンが無いときは検索せず、行を出さない", async () => {
    setActive("");
    render(<RelatedScenesPanel isActive />);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("非表示 (isActive=false) のときは検索しない", () => {
    setActive("s2");
    render(<RelatedScenesPanel isActive={false} />);
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
    mockFetch.mockResolvedValue(scenes);
    setActive("s2");
    render(<RelatedScenesPanel isActive />);

    await waitFor(() => {
      expect(screen.getByText("井戸端の密談")).toBeTruthy();
    });
    expect(mockFetch).toHaveBeenCalledWith("s2");
    expect(screen.getByText("92%")).toBeTruthy();
    expect(screen.getByText("エリカが鍵を渡した場面")).toBeTruthy();
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
    mockFetch.mockResolvedValue(scenes);
    seedNodes(["s1", "s2"]);
    setActive("s2");
    render(<RelatedScenesPanel isActive />);

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
    mockFetch.mockResolvedValue(scenes);
    seedNodes(["s2"]); // "deleted" は tree に無い
    setActive("s2");
    render(<RelatedScenesPanel isActive />);

    const row = await screen.findByText("消えた章");
    fireEvent.click(row);

    expect(useSemanticNavStore.getState().pendingJump).toBeNull();
    expect(useTreeStore.getState().activeSceneId).toBe("s2");
  });
});
