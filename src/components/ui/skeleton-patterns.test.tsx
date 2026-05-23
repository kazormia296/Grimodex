// @vitest-environment happy-dom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ListRowSkeletonList, TreeRowSkeletonList } from "./skeleton-patterns";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("skeleton-patterns", () => {
  it("shows tree row skeleton list with aria-busy", () => {
    render(<TreeRowSkeletonList />);
    expect(screen.getByTestId("tree-row-skeleton-list")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });

  it("shows list row skeleton list with aria-busy", () => {
    render(<ListRowSkeletonList />);
    expect(screen.getByTestId("list-row-skeleton-list")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});
