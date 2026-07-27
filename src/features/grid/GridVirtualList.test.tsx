// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => ({
  options: null as null | {
    count: number;
    getItemKey: (index: number) => string | number;
    rangeExtractor: (range: {
      startIndex: number;
      endIndex: number;
      overscan: number;
      count: number;
    }) => number[];
  },
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: NonNullable<typeof capture.options>) => {
    capture.options = options;
    return {
      getTotalSize: () => options.count * 100,
      getVirtualItems: () =>
        [0, 1]
          .filter((index) => index < options.count)
          .map((index) => ({
            index,
            key: options.getItemKey(index),
            start: index * 100,
          })),
      measureElement: vi.fn(),
    };
  },
}));

import { extractGridVirtualIndexes, GridVirtualList } from "./GridVirtualList";

describe("GridVirtualList", () => {
  it("mounts only the virtual window for a project-scale column", () => {
    const items = Array.from({ length: 10_000 }, (_, index) => ({
      id: `scene-${index}`,
    }));
    const { container } = render(
      <GridVirtualList
        items={items}
        compact={false}
        renderItem={(item) => <div data-card-id={item.id} />}
        endRef={() => {}}
        endClassName=""
      />,
    );

    expect(capture.options?.count).toBe(10_000);
    expect(capture.options?.getItemKey(9_999)).toBe("scene-9999");
    expect(container.querySelectorAll("[data-card-id]")).toHaveLength(2);
  });

  it("pins only the active drag row instead of expanding to every item", () => {
    expect(
      extractGridVirtualIndexes(
        {
          startIndex: 100,
          endIndex: 105,
          overscan: 2,
          count: 10_000,
        },
        9_000,
      ),
    ).toEqual([98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 9_000]);
  });
});
