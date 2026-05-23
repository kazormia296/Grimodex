import { describe, it, expect } from "vitest";
import { SyncForceLayoutEngine } from "./forceEngine";

describe("SyncForceLayoutEngine", () => {
  it("全ノードの座標が返る", async () => {
    const engine = new SyncForceLayoutEngine();
    const result = await engine.run({
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      links: [{ source: "a", target: "b" }],
      options: { iterations: 50 },
    });
    expect(result.positions).toHaveLength(3);
    const ids = result.positions.map((p) => p.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
  });

  it("全ノードが有限座標を持つ", async () => {
    const engine = new SyncForceLayoutEngine();
    const result = await engine.run({
      nodes: [{ id: "n1" }, { id: "n2" }],
      links: [],
      options: { iterations: 30 },
    });
    for (const pos of result.positions) {
      expect(isFinite(pos.x)).toBe(true);
      expect(isFinite(pos.y)).toBe(true);
    }
  });

  it("progress コールバックが呼ばれる", async () => {
    const engine = new SyncForceLayoutEngine();
    const alphas: number[] = [];
    await engine.run(
      {
        nodes: [{ id: "x" }, { id: "y" }],
        links: [],
        options: { iterations: 40 },
      },
      (alpha) => alphas.push(alpha),
    );
    expect(alphas.length).toBeGreaterThan(0);
  });

  it("リンクで繋がったノードが繋がっていないノードより近くなる", async () => {
    const engine = new SyncForceLayoutEngine();
    const result = await engine.run({
      nodes: [{ id: "linked1" }, { id: "linked2" }, { id: "isolated" }],
      links: [{ source: "linked1", target: "linked2", strength: 0.9 }],
      options: { iterations: 200 },
    });
    const pos = new Map(result.positions.map((p) => [p.id, p]));
    const distLinked = Math.hypot(
      pos.get("linked1")!.x - pos.get("linked2")!.x,
      pos.get("linked1")!.y - pos.get("linked2")!.y,
    );
    const distIsolated1 = Math.hypot(
      pos.get("linked1")!.x - pos.get("isolated")!.x,
      pos.get("linked1")!.y - pos.get("isolated")!.y,
    );
    const distIsolated2 = Math.hypot(
      pos.get("linked2")!.x - pos.get("isolated")!.x,
      pos.get("linked2")!.y - pos.get("isolated")!.y,
    );
    expect(distLinked).toBeLessThan(distIsolated1);
    expect(distLinked).toBeLessThan(distIsolated2);
  });

  it("提供された x,y を初期座標として使う", async () => {
    const engine = new SyncForceLayoutEngine();
    const result = await engine.run({
      nodes: [{ id: "only", x: 123, y: 456 }],
      links: [],
      options: { iterations: 0, randomSeed: 42 },
    });
    expect(result.positions[0]).toEqual({ id: "only", x: 123, y: 456 });
  });

  it("同一 seed + 同一 input で同一 output になる", async () => {
    const engine = new SyncForceLayoutEngine();
    const input = {
      nodes: [
        { id: "a", tags: ["fantasy"] },
        { id: "b", tags: ["fantasy", "magic"] },
        { id: "c", tags: ["sci-fi"] },
      ],
      links: [{ source: "a", target: "b", strength: 0.4 }],
      options: { randomSeed: 12345, iterations: 120 },
    };
    const first = await engine.run(input);
    const second = await engine.run(input);
    expect(first.positions).toEqual(second.positions);
  });
});
