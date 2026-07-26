// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createRef } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

import { useTreeStore } from "@/features/tree/treeStore";
import { useAnnotationStore } from "./annotationStore";
import { AnnotationHoverPopover } from "./AnnotationHoverPopover";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

function renderWithSpan(attrs: Record<string, string>) {
  const containerRef = createRef<HTMLDivElement>();
  render(
    <div ref={containerRef}>
      <span data-testid="deco" {...attrs}>
        指摘対象テキスト
      </span>
      <AnnotationHoverPopover containerRef={containerRef} />
    </div>,
  );
  return screen.getByTestId("deco");
}

beforeEach(() => {
  useTreeStore.setState({ activeSceneId: "s1" } as never);
  useAnnotationStore.setState({
    showAnnotations: true,
    annotationsByScene: new Map([
      [
        "s1",
        [
          {
            id: "a1",
            category: "review",
            severity: "error",
            status: "open",
            content: "この段落は視点が揺れています",
          },
        ] as never,
      ],
    ]),
  });
});

describe("AnnotationHoverPopover", () => {
  it("校閲の指摘をホバーすると観点ラベル+指摘本文のポップオーバーが出る", () => {
    const deco = renderWithSpan({
      "data-pe-ann-id": "a1",
      "data-pe-category": "review",
    });
    fireEvent.mouseOver(deco);
    const popover = screen.getByTestId("annotation-hover-popover");
    expect(popover.textContent).toContain("この段落は視点が揺れています");
    // review 観点は CAT_LABEL_KEY 経由の i18n キー
    expect(popover.textContent).toContain("kouetsu.editorial.review");
  });

  it("pseudo_comment (読者コメント) は対象外 (PseudoCommentBubble の担当)", () => {
    const deco = renderWithSpan({
      "data-pe-ann-id": "a1",
      "data-pe-category": "pseudo_comment",
    });
    fireEvent.mouseOver(deco);
    expect(screen.queryByTestId("annotation-hover-popover")).toBeNull();
  });

  it("showAnnotations OFF ではホバーしても出ない", () => {
    useAnnotationStore.setState({ showAnnotations: false });
    const deco = renderWithSpan({
      "data-pe-ann-id": "a1",
      "data-pe-category": "review",
    });
    fireEvent.mouseOver(deco);
    expect(screen.queryByTestId("annotation-hover-popover")).toBeNull();
  });
});
