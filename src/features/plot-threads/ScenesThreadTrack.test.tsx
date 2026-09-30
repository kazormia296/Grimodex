// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ScenesThreadTrack } from "./ScenesThreadTrack";
import type { PlotThreadRow } from "./api";

function thread(over: Partial<PlotThreadRow> & { id: string }): PlotThreadRow {
  return {
    projectId: "p1",
    name: over.id,
    color: null,
    description: null,
    sortOrder: "a0",
    startNodeId: null,
    endNodeId: null,
    version: 0,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

afterEach(cleanup);

const columns = [
  thread({ id: "t1", name: "Romance", color: "#ff0000" }),
  thread({ id: "t2", name: "Mystery", color: null }),
];

describe("ScenesThreadTrack", () => {
  it("renders nothing when there are no columns", () => {
    const { container } = render(<ScenesThreadTrack cells="" columns={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("draws a station node for station chars (t/b/s/o) but not for pass (|)", () => {
    // t1=station(t), t2=pass(|)
    const { container, getByTestId } = render(
      <ScenesThreadTrack cells="t|" columns={columns} />,
    );
    expect(getByTestId("scene-track-node-t1")).toBeTruthy();
    expect(
      container.querySelector('[data-testid="scene-track-node-t2"]'),
    ).toBeNull();
  });

  it("does not draw a line for single-station (o)", () => {
    const { getByTestId } = render(
      <ScenesThreadTrack cells="o." columns={columns} />,
    );
    const cell = getByTestId("scene-track-t1-o");
    // node present, but no line child (line is the non-rounded span)
    expect(
      cell.querySelector('[data-testid="scene-track-node-t1"]'),
    ).toBeTruthy();
    // only the node span exists inside the cell (no separate line span)
    expect(cell.querySelectorAll("span").length).toBe(1);
  });

  it("renders branch (solid) and merge (dashed) connectors", () => {
    const { getByTestId } = render(
      <ScenesThreadTrack cells="oo" columns={columns} connectors="0>1:b" />,
    );
    const conn = getByTestId("scene-track-connector-branch") as HTMLElement;
    expect(conn.style.borderTop).toContain("solid");

    cleanup();
    const { getByTestId: get2 } = render(
      <ScenesThreadTrack cells="oo" columns={columns} connectors="0>1:m" />,
    );
    expect(
      (get2("scene-track-connector-merge") as HTMLElement).style.borderTop,
    ).toContain("dashed");
  });

  it("ignores connectors referencing out-of-range columns", () => {
    const { container } = render(
      <ScenesThreadTrack cells="o" columns={[columns[0]]} connectors="0>5:b" />,
    );
    expect(
      container.querySelector('[data-testid^="scene-track-connector"]'),
    ).toBeNull();
  });

  it("T=流入端は下向き半線・駅なし / B=離脱端は上向き半線・駅なし", () => {
    const { getByTestId, container } = render(
      <ScenesThreadTrack cells="T" columns={[columns[0]]} />,
    );
    expect((getByTestId("scene-track-line-t1") as HTMLElement).style.top).toBe(
      "50%",
    );
    expect(
      container.querySelector('[data-testid="scene-track-node-t1"]'),
    ).toBeNull();

    cleanup();
    const { getByTestId: g2, container: c2 } = render(
      <ScenesThreadTrack cells="B" columns={[columns[0]]} />,
    );
    expect((g2("scene-track-line-t1") as HTMLElement).style.bottom).toBe("50%");
    expect(c2.querySelector('[data-testid="scene-track-node-t1"]')).toBeNull();
  });

  it("uses thread color, falling back to var(--primary) when null", () => {
    const { getByTestId } = render(
      <ScenesThreadTrack cells="t" columns={[columns[1]]} />,
    );
    const node = getByTestId("scene-track-node-t2") as HTMLElement;
    expect(node.style.backgroundColor).toContain("--primary");
  });
});
