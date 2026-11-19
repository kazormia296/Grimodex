// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useSceneStore } from "@/features/tree/store";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { StorySoFarCoverage } from "./StorySoFarCoverage";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const NOW = "2026-01-01T00:00:00.000Z";

function node(
  overrides: Partial<TreeNodeData> &
    Pick<TreeNodeData, "id" | "nodeType" | "sortOrder">,
): TreeNodeData {
  return {
    projectId: "project-1",
    parentId: null,
    title: overrides.id,
    synopsis: null,
    intent: null,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("StorySoFarCoverage reading order", () => {
  afterEach(() => {
    cleanup();
  });

  it("counts only scenes before the current one in reading order, not a later chapter", () => {
    // 章 2 の 1 場面目は sortOrder(a0) が現在場面(a1)より小さいが、読む順では後。
    useTreeStore.setState({
      nodes: [
        node({ id: "ch1", nodeType: "folder", sortOrder: "a0" }),
        node({ id: "ch2", nodeType: "folder", sortOrder: "a1" }),
        node({
          id: "c1s1",
          nodeType: "scene",
          parentId: "ch1",
          sortOrder: "a0",
        }),
        node({
          id: "c1s2",
          nodeType: "scene",
          parentId: "ch1",
          sortOrder: "a1",
        }),
        node({
          id: "c2s1",
          nodeType: "scene",
          parentId: "ch2",
          sortOrder: "a0",
          synopsis: "later chapter synopsis",
        }),
      ],
    } as never);
    useSceneStore.setState({ activeSceneId: "c1s2" } as never);

    render(<StorySoFarCoverage />);

    // 前にあるのは c1s1 だけ（あらすじなし）→ 0/1。章 2 を数えると 1/2 になる。
    expect(screen.getByText("storySoFar: 0/1")).toBeTruthy();
  });
});
