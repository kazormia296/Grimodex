/**
 * 実 Chromium で「縦版ミニ・タイムライン」トラックの幾何 invariant を gate する。
 * happy-dom は getBoundingClientRect を計算しないため、列の x 整列・半線の上下・
 * 行をまたぐ縦線の連続性は実描画でしか検証できない。
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { ScenesThreadTrack } from "./ScenesThreadTrack";
import type { PlotThreadRow } from "./api";

afterEach(cleanup);

const t1: PlotThreadRow = {
  id: "t1",
  projectId: "p1",
  name: "T1",
  color: "#ff0000",
  description: null,
  sortOrder: "a0",
  startNodeId: null,
  endNodeId: null,
  createdAt: "",
  updatedAt: "",
};

const ROW_H = 24;

function StackedRows({ rows }: { rows: string[] }) {
  return (
    <div style={{ width: 200 }}>
      {rows.map((cells, i) => (
        <div key={i} style={{ position: "relative", height: ROW_H }}>
          <ScenesThreadTrack cells={cells} columns={[t1]} />
        </div>
      ))}
    </div>
  );
}

describe("ScenesThreadTrack geometry (real DOM)", () => {
  it("駅は列の同じ x に整列し、半線は中央から伸び、行をまたいで連続する", () => {
    // 行0=先頭駅(t) / 行1=通過(|) / 行2=末尾駅(b)
    const { getAllByTestId } = render(<StackedRows rows={["t", "|", "b"]} />);

    const nodes = getAllByTestId("scene-track-node-t1");
    expect(nodes.length).toBe(2); // t と b のみ（| は駅なし）
    const n0 = nodes[0].getBoundingClientRect();
    const n2 = nodes[1].getBoundingClientRect();
    // 列の x 整列（中心一致）
    expect(
      Math.abs((n0.left + n0.right) / 2 - (n2.left + n2.right) / 2),
    ).toBeLessThan(0.6);

    const lines = getAllByTestId("scene-track-line-t1");
    // 3 行とも線を持つ（t=下半分 / |=全高 / b=上半分）
    expect(lines.length).toBe(3);
    const l0 = lines[0].getBoundingClientRect(); // 先頭駅: 中央→下
    const l1 = lines[1].getBoundingClientRect(); // 通過: 全高
    const l2 = lines[2].getBoundingClientRect(); // 末尾駅: 上→中央

    // 先頭行の線は行の上半分には無い（中央付近から始まる）
    expect(l0.top).toBeGreaterThan(l1.top + ROW_H * 0.3);
    // 末尾行の線は行の下半分には無い（中央付近で終わる）
    expect(l2.bottom).toBeLessThan(l1.bottom - ROW_H * 0.3);
    // 行をまたぐ連続性: 行0 の線の下端 ≈ 行1 の線の上端
    expect(Math.abs(l0.bottom - l1.top)).toBeLessThan(1.5);
    // 線も列の x に整列
    expect(
      Math.abs((l1.left + l1.right) / 2 - (n0.left + n0.right) / 2),
    ).toBeLessThan(0.6);
  });

  it("複数列は別々の x に分かれて並ぶ", () => {
    const t2: PlotThreadRow = {
      ...t1,
      id: "t2",
      color: "#00ff00",
      sortOrder: "a1",
    };
    const { getByTestId } = render(
      <div style={{ width: 200 }}>
        <div style={{ position: "relative", height: ROW_H }}>
          <ScenesThreadTrack cells={"oo"} columns={[t1, t2]} />
        </div>
      </div>,
    );
    const a = getByTestId("scene-track-node-t1").getBoundingClientRect();
    const b = getByTestId("scene-track-node-t2").getBoundingClientRect();
    expect(b.left).toBeGreaterThan(a.left + 4); // 別列＝別 x
  });
});
