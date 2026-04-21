// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SynopsisHeader } from "./SynopsisHeader";
import { useTreeStore } from "@/features/tree/treeStore";

const NODE_DEFAULTS = {
  projectId: "p",
  parentId: null as null,
  sortOrder: "a1",
  status: null as null,
  synopsis: null as string | null,
  storyTimeOrder: null as string | null,
  storyTimeLabel: null as string | null,
  createdAt: "2024-01-01T00:00:00Z",
};

function setScene(
  overrides: Partial<typeof NODE_DEFAULTS & { id: string }> & { id: string },
) {
  useTreeStore.setState({
    nodes: [
      {
        ...NODE_DEFAULTS,
        nodeType: "scene",
        title: "テストシーン",
        ...overrides,
      },
    ],
  });
}

beforeEach(() => {
  useTreeStore.setState({ nodes: [] });
});

describe("SynopsisHeader", () => {
  it("story_time_label がない場合はラベルを表示しない", () => {
    setScene({ id: "s1", storyTimeLabel: null });
    const { container } = render(<SynopsisHeader sceneId="s1" />);
    // data-testid="story-time-label" が存在しないこと
    expect(
      container.querySelector("[data-testid='story-time-label']"),
    ).toBeNull();
  });

  it("story_time_label がある場合は表示する", () => {
    setScene({ id: "s1", storyTimeLabel: "帝国暦1024年" });
    render(<SynopsisHeader sceneId="s1" />);
    expect(screen.getByTestId("story-time-label")).toBeDefined();
    expect(screen.getByTestId("story-time-label").textContent).toBe(
      "帝国暦1024年",
    );
  });

  it("story_time_label は編集不可（input/button でない）", () => {
    setScene({ id: "s1", storyTimeLabel: "Day 3 morning" });
    render(<SynopsisHeader sceneId="s1" />);
    const el = screen.getByTestId("story-time-label");
    expect(el.tagName).not.toBe("INPUT");
    expect(el.tagName).not.toBe("BUTTON");
    expect(el.tagName).not.toBe("TEXTAREA");
  });

  it("ノードが存在しない場合は何もレンダリングしない", () => {
    const { container } = render(<SynopsisHeader sceneId="non-existent" />);
    expect(container.firstChild).toBeNull();
  });

  it("scene 以外のノードは何もレンダリングしない", () => {
    useTreeStore.setState({
      nodes: [
        { ...NODE_DEFAULTS, id: "f1", nodeType: "folder", title: "第一章" },
      ],
    });
    const { container } = render(<SynopsisHeader sceneId="f1" />);
    expect(container.firstChild).toBeNull();
  });
});
