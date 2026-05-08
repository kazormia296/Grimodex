import { describe, expect, it } from "vitest";
import { TrashPhysicsEngine } from "./physics";

const W = 400;
const FLOOR = 600;
const STEP_MS = 1000 / 60;

/** Mulberry32 — テスト用 seed 可能 PRNG。 */
function seedRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeEngine() {
  const e = new TrashPhysicsEngine();
  e.setBounds(W, FLOOR);
  return e;
}

describe("TrashPhysicsEngine.addBody", () => {
  it("falling: y は -h あたりから始まる", () => {
    const e = makeEngine();
    const s = e.addBody({
      id: "a",
      subKind: "text-fragment",
      size: { width: 100, height: 30 },
      initial: "falling",
      containerWidth: W,
      rng: seedRng(1),
    });
    expect(s.y).toBe(-30);
    expect(s.isSleeping).toBe(false);
    e.destroy();
  });

  it("settled-floor: 床面に接してかつ sleeping=true", () => {
    const e = makeEngine();
    const s = e.addBody({
      id: "a",
      subKind: "scene",
      size: { width: 200, height: 80 },
      initial: "settled-floor",
      x: 50,
      y: FLOOR - 80,
    });
    expect(s.y).toBe(FLOOR - 80);
    expect(s.isSleeping).toBe(true);
    e.destroy();
  });
});

describe("TrashPhysicsEngine.step 重力・床", () => {
  it("body は重力で落下し、床で止まる", () => {
    const e = makeEngine();
    e.addBody({
      id: "a",
      subKind: "text-fragment",
      size: { width: 60, height: 24 },
      initial: "falling",
      containerWidth: W,
      x: 100,
      rng: seedRng(1),
    });
    let steps = 0;
    while (e.hasUnsettled() && steps < 600) {
      e.step(STEP_MS);
      steps += 1;
    }
    expect(e.hasUnsettled()).toBe(false);
    const s = e.getState("a")!;
    expect(s.y + s.height).toBeLessThanOrEqual(FLOOR + 0.5);
    expect(s.isSleeping).toBe(true);
    e.destroy();
  });

  it("settled-floor の body は step 後も寝ている", () => {
    const e = makeEngine();
    e.addBody({
      id: "a",
      subKind: "scene",
      size: { width: 200, height: 80 },
      initial: "settled-floor",
      x: 50,
      y: FLOOR - 80,
    });
    e.step(STEP_MS);
    const s = e.getState("a")!;
    expect(s.isSleeping).toBe(true);
    e.destroy();
  });
});

describe("TrashPhysicsEngine.shake", () => {
  it("settled body を起こす", () => {
    const e = makeEngine();
    e.addBody({
      id: "a",
      subKind: "scene",
      size: { width: 200, height: 80 },
      initial: "settled-floor",
      x: 50,
      y: FLOOR - 80,
    });
    expect(e.getState("a")!.isSleeping).toBe(true);
    e.shake(400, 400, seedRng(7));
    expect(e.getState("a")!.isSleeping).toBe(false);
    e.destroy();
  });

  it("static body は無視される（ドラッグ中の対象を勝手に動かさない）", () => {
    const e = makeEngine();
    e.addBody({
      id: "a",
      subKind: "scene",
      size: { width: 200, height: 80 },
      initial: "settled-floor",
      x: 50,
      y: FLOOR - 80,
    });
    e.beginDrag("a");
    const before = e.getState("a")!;
    e.shake(400, 400, seedRng(7));
    e.step(STEP_MS);
    const after = e.getState("a")!;
    expect(after.x).toBeCloseTo(before.x, 5);
    expect(after.y).toBeCloseTo(before.y, 5);
    e.destroy();
  });
});

describe("TrashPhysicsEngine drag", () => {
  it("beginDrag → dragTo で位置を制御できる", () => {
    const e = makeEngine();
    e.addBody({
      id: "a",
      subKind: "text-fragment",
      size: { width: 60, height: 24 },
      initial: "falling",
      containerWidth: W,
      x: 100,
      rng: seedRng(1),
    });
    e.beginDrag("a");
    expect(e.isStatic("a")).toBe(true);
    e.dragTo("a", 200, 50);
    e.step(STEP_MS);
    const s = e.getState("a")!;
    expect(s.x).toBeCloseTo(200, 1);
    expect(s.y).toBeCloseTo(50, 1);
    e.destroy();
  });

  it("endDrag で動的に戻り、その後落下する", () => {
    const e = makeEngine();
    e.addBody({
      id: "a",
      subKind: "text-fragment",
      size: { width: 60, height: 24 },
      initial: "falling",
      containerWidth: W,
      x: 100,
      rng: seedRng(1),
    });
    e.beginDrag("a");
    e.dragTo("a", 200, 50);
    e.endDrag("a");
    expect(e.isStatic("a")).toBe(false);
    const before = e.getState("a")!;
    for (let i = 0; i < 10; i++) e.step(STEP_MS);
    const after = e.getState("a")!;
    expect(after.y).toBeGreaterThan(before.y);
    e.destroy();
  });
});

describe("TrashPhysicsEngine.removeBody", () => {
  it("削除後は getState/hasBody が応えない", () => {
    const e = makeEngine();
    e.addBody({
      id: "a",
      subKind: "text-fragment",
      size: { width: 60, height: 24 },
      initial: "falling",
      containerWidth: W,
      rng: seedRng(1),
    });
    expect(e.hasBody("a")).toBe(true);
    e.removeBody("a");
    expect(e.hasBody("a")).toBe(false);
    expect(e.getState("a")).toBeNull();
    e.destroy();
  });
});

describe("TrashPhysicsEngine.placeFloorPreset", () => {
  const items = [
    {
      id: "a",
      subKind: "text-fragment" as const,
      size: { width: 60, height: 24 },
    },
    { id: "b", subKind: "scene" as const, size: { width: 200, height: 80 } },
    {
      id: "c",
      subKind: "snippet" as const,
      size: { width: 140, height: 100 },
    },
  ];

  it("seed 固定で決定論的に同じ位置を返す", () => {
    const e1 = makeEngine();
    e1.placeFloorPreset(items, seedRng(7));
    const s1 = items.map((i) => e1.getState(i.id)!);
    e1.destroy();

    const e2 = makeEngine();
    e2.placeFloorPreset(items, seedRng(7));
    const s2 = items.map((i) => e2.getState(i.id)!);
    e2.destroy();

    for (let i = 0; i < items.length; i++) {
      expect(s1[i].x).toBeCloseTo(s2[i].x, 5);
      expect(s1[i].y).toBeCloseTo(s2[i].y, 5);
    }
  });

  it("全 body が床より下にはみ出さず sleeping", () => {
    const e = makeEngine();
    e.placeFloorPreset(items, seedRng(7));
    for (const it of items) {
      const s = e.getState(it.id)!;
      expect(s.y + s.height).toBeLessThanOrEqual(FLOOR + 0.5);
      expect(s.isSleeping).toBe(true);
    }
    e.destroy();
  });

  it("空 items でも例外を投げない", () => {
    const e = makeEngine();
    expect(() => e.placeFloorPreset([], seedRng(7))).not.toThrow();
    e.destroy();
  });
});

describe("TrashPhysicsEngine.clampBodies", () => {
  it("リサイズで境界外の sleeping body を内側にクランプし wake する", () => {
    const e = makeEngine();
    e.addBody({
      id: "a",
      subKind: "scene",
      size: { width: 200, height: 80 },
      initial: "settled-floor",
      x: 200,
      y: FLOOR - 80,
    });
    expect(e.getState("a")!.isSleeping).toBe(true);
    // body 幅 (200) より広い 250 幅にリサイズ → 通常クランプ
    e.setBounds(250, FLOOR);
    const awoke = e.clampBodies();
    const s = e.getState("a")!;
    expect(s.x).toBeGreaterThanOrEqual(0);
    expect(s.x + s.width).toBeLessThanOrEqual(250 + 0.5);
    // wake させて重力で再着地・整列させる（calm period が爆発を吸収）
    expect(s.isSleeping).toBe(false);
    expect(awoke).toBe(true);
    e.destroy();
  });

  it("body が container より幅広いときは左寄せ（右側はみ出しを許容）", () => {
    const e = makeEngine();
    e.addBody({
      id: "a",
      subKind: "scene",
      size: { width: 200, height: 80 },
      initial: "settled-floor",
      x: 100,
      y: FLOOR - 80,
    });
    // body 幅 200 > container 幅 150
    e.setBounds(150, FLOOR);
    e.clampBodies();
    const s = e.getState("a")!;
    expect(s.x).toBeCloseTo(0, 1); // 左端に揃う
    e.destroy();
  });

  it("リサイズで落下中の body は wake のままクランプされる", () => {
    const e = makeEngine();
    e.addBody({
      id: "a",
      subKind: "text-fragment",
      size: { width: 60, height: 24 },
      initial: "falling",
      containerWidth: 400,
      x: 350, // はみ出させる
      y: 100,
      rng: seedRng(1),
    });
    expect(e.getState("a")!.isSleeping).toBe(false);
    e.setBounds(200, FLOOR);
    const awoke = e.clampBodies();
    const s = e.getState("a")!;
    expect(s.x + s.width).toBeLessThanOrEqual(200 + 0.5);
    // 落下中は wake のまま（重力で再着地できるように）
    expect(s.isSleeping).toBe(false);
    expect(awoke).toBe(true);
    e.destroy();
  });
});

describe("TrashPhysicsEngine.hasUnsettled", () => {
  it("動的 body が起きていれば true", () => {
    const e = makeEngine();
    e.addBody({
      id: "a",
      subKind: "text-fragment",
      size: { width: 60, height: 24 },
      initial: "falling",
      containerWidth: W,
      rng: seedRng(1),
    });
    expect(e.hasUnsettled()).toBe(true);
    e.destroy();
  });

  it("全て sleeping/static なら false", () => {
    const e = makeEngine();
    e.addBody({
      id: "a",
      subKind: "scene",
      size: { width: 200, height: 80 },
      initial: "settled-floor",
      x: 50,
      y: FLOOR - 80,
    });
    expect(e.hasUnsettled()).toBe(false);
    e.destroy();
  });

  it("空配列は false", () => {
    const e = makeEngine();
    expect(e.hasUnsettled()).toBe(false);
    e.destroy();
  });
});
