// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
import {
  beginGridVirtualRowEditing,
  resetGridVirtualEditingForTests,
  useGridVirtualEditingStore,
} from "./gridVirtualEditingStore";

afterEach(() => {
  resetGridVirtualEditingForTests();
});

describe("GridVirtualList", () => {
  it("keeps a row pinned until every editing owner releases it", () => {
    const releaseTitle = beginGridVirtualRowEditing("scene-1");
    const releaseBeat = beginGridVirtualRowEditing("scene-1");

    releaseTitle();
    expect(
      useGridVirtualEditingStore.getState().editingRowIds.has("scene-1"),
    ).toBe(true);

    releaseBeat();
    releaseBeat();
    expect(
      useGridVirtualEditingStore.getState().editingRowIds.has("scene-1"),
    ).toBe(false);
  });

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

  it("pins drag and editing rows instead of expanding to every item", () => {
    const items = Array.from({ length: 10_000 }, (_, index) => ({
      id: `scene-${index}`,
    }));
    const releaseEditing = beginGridVirtualRowEditing("scene-8000");
    render(
      <GridVirtualList
        items={items}
        pinnedItemId="scene-9000"
        compact={false}
        renderItem={(item) => <div data-card-id={item.id} />}
        endRef={() => {}}
        endClassName=""
      />,
    );

    expect(
      capture.options?.rangeExtractor({
        startIndex: 100,
        endIndex: 105,
        overscan: 2,
        count: 10_000,
      }),
    ).toEqual([98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 8_000, 9_000]);
    expect(
      extractGridVirtualIndexes(
        {
          startIndex: 100,
          endIndex: 105,
          overscan: 2,
          count: 10_000,
        },
        [9_000, 8_000, 9_000, -1, 10_000],
      ),
    ).toEqual([98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 8_000, 9_000]);
    releaseEditing();
  });
});
