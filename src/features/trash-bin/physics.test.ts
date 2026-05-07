import { describe, expect, it } from "vitest";
import {
  applyShake,
  attach,
  BOUNCE_DAMPING,
  createBody,
  detach,
  GRAVITY,
  hasUnsettled,
  placeFloorPreset,
  PhysicsBody,
  SLEEP_FRAMES,
  stepPhysics,
  SUBKIND_MASS,
  WALL_DAMPING,
  wakeNeighbors,
} from "./physics";

const W = 400;
const FLOOR = 600;
const DT = 1 / 60;

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

function makeBody(over: Partial<PhysicsBody>): PhysicsBody {
  return {
    id: "x",
    subKind: "text-fragment",
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    width: 60,
    height: 24,
    mass: 1,
    rotation: 0,
    rotationV: 0,
    settled: false,
    detached: false,
    settleFrames: 0,
    ...over,
  };
}

describe("createBody", () => {
  it("falling: y=-h で settled=false、subKind 別 mass を反映", () => {
    const b = createBody({
      id: "a",
      subKind: "text-fragment",
      containerWidth: W,
      size: { width: 100, height: 30 },
      rng: seedRng(1),
      initial: "falling",
    });
    expect(b.y).toBe(-30);
    expect(b.settled).toBe(false);
    expect(b.mass).toBe(SUBKIND_MASS["text-fragment"]);
  });

  it("settled-floor: 床面で settled=true", () => {
    const b = createBody({
      id: "a",
      subKind: "scene",
      containerWidth: W,
      size: { width: 200, height: 80 },
      rng: seedRng(1),
      initial: "settled-floor",
      floorY: FLOOR,
    });
    expect(b.y).toBe(FLOOR - 80);
    expect(b.vx).toBe(0);
    expect(b.vy).toBe(0);
    expect(b.settled).toBe(true);
    expect(b.mass).toBe(SUBKIND_MASS.scene);
  });

  it("settled-floor で floorY 未指定なら throw", () => {
    expect(() =>
      createBody({
        id: "a",
        subKind: "scene",
        containerWidth: W,
        size: { width: 200, height: 80 },
        rng: seedRng(1),
        initial: "settled-floor",
      }),
    ).toThrow();
  });
});

describe("stepPhysics 退化ケース", () => {
  it("空配列はそのまま空配列を返す", () => {
    expect(stepPhysics([], DT, FLOOR, W)).toEqual([]);
  });

  it("dt=0 では位置・速度が変わらない", () => {
    const b = makeBody({ x: 50, y: 50, vx: 10, vy: 20 });
    const after = stepPhysics([b], 0, FLOOR, W);
    expect(after[0].x).toBe(50);
    expect(after[0].y).toBe(50);
    expect(after[0].vx).toBe(10);
    expect(after[0].vy).toBe(20);
  });

  it("入力配列を mutate しない", () => {
    const b = makeBody({ x: 50, y: 50 });
    const orig = { ...b };
    stepPhysics([b], DT, FLOOR, W);
    expect(b).toEqual(orig);
  });
});

describe("stepPhysics 重力・床", () => {
  it("body は重力で落下し、床でバウンスして settle する", () => {
    let bodies: PhysicsBody[] = [
      makeBody({ x: 100, y: 0, vx: 0, vy: 0, width: 60, height: 24 }),
    ];
    let steps = 0;
    while (hasUnsettled(bodies) && steps < 600) {
      bodies = stepPhysics(bodies, DT, FLOOR, W);
      steps += 1;
    }
    expect(bodies[0].settled).toBe(true);
    expect(Math.abs(bodies[0].y + bodies[0].height - FLOOR)).toBeLessThan(1);
    expect(bodies[0].vx).toBe(0);
    expect(bodies[0].vy).toBe(0);
  });

  it("床着地で BOUNCE_DAMPING が掛かる", () => {
    // 床直前に置いて速度を持たせる
    const b = makeBody({ y: FLOOR - 24 - 1, vy: 100, width: 60, height: 24 });
    const after = stepPhysics([b], DT, FLOOR, W);
    expect(after[0].y + after[0].height).toBeCloseTo(FLOOR, 5);
    expect(after[0].vy).toBeLessThan(0);
    // step 内で gravity が一回乗るので bounce 前の vy は 100 + GRAVITY*DT
    const preBounceVy = 100 + (GRAVITY * DT) / 1;
    expect(Math.abs(after[0].vy)).toBeCloseTo(preBounceVy * BOUNCE_DAMPING, 1);
  });

  it("settled body は次フレームで位置・速度不変", () => {
    const b = createBody({
      id: "a",
      subKind: "scene",
      containerWidth: W,
      size: { width: 200, height: 80 },
      rng: seedRng(1),
      initial: "settled-floor",
      floorY: FLOOR,
    });
    const after = stepPhysics([b], DT, FLOOR, W);
    expect(after[0].x).toBe(b.x);
    expect(after[0].y).toBe(b.y);
    expect(after[0].vx).toBe(0);
    expect(after[0].vy).toBe(0);
    expect(after[0].settled).toBe(true);
  });

  it("重力は mass で割られる（重い body はゆっくり落下）", () => {
    const light = makeBody({ id: "l", x: 50, y: 0, mass: 1 });
    const heavy = makeBody({ id: "h", x: 200, y: 0, mass: 3 });
    const after = stepPhysics([light, heavy], DT, FLOOR, W);
    expect(after[0].vy).toBeCloseTo(GRAVITY * DT, 5);
    expect(after[1].vy).toBeCloseTo((GRAVITY * DT) / 3, 5);
  });
});

describe("stepPhysics 壁反射", () => {
  it("右壁で vx が反転し WALL_DAMPING が掛かる", () => {
    const b = makeBody({
      x: W - 60 - 1,
      y: 100,
      vx: 200,
      width: 60,
      height: 24,
    });
    const after = stepPhysics([b], DT, FLOOR, W);
    expect(after[0].x).toBe(W - 60);
    expect(after[0].vx).toBeLessThan(0);
    expect(Math.abs(after[0].vx)).toBeCloseTo(200 * WALL_DAMPING, 1);
  });

  it("左壁で vx が反転", () => {
    const b = makeBody({ x: 1, y: 100, vx: -200 });
    const after = stepPhysics([b], DT, FLOOR, W);
    expect(after[0].x).toBe(0);
    expect(after[0].vx).toBeGreaterThan(0);
  });
});

describe("stepPhysics AABB 衝突", () => {
  it("重なる 2 body は引き離される（軽い側が大きく動く）", () => {
    const heavy = makeBody({
      id: "h",
      subKind: "scene",
      x: 100,
      y: 100,
      width: 100, // x: 100..200
      height: 80, // y: 100..180
      mass: 3,
      vx: 0,
    });
    const light = makeBody({
      id: "l",
      x: 150, // overlapX=50
      y: 100, // overlapY=80 → x 軸で分離される
      width: 100,
      height: 80,
      mass: 1,
      vx: 0,
    });
    const after = stepPhysics([heavy, light], 0.001, FLOOR, W);
    const heavyDx = Math.abs(after[0].x - heavy.x);
    const lightDx = Math.abs(after[1].x - light.x);
    expect(lightDx).toBeGreaterThan(heavyDx);
    // separated: light pushed right, heavy pushed left
    expect(after[1].x).toBeGreaterThan(light.x);
    expect(after[0].x).toBeLessThan(heavy.x);
  });

  it("離れている body 同士は影響しあわない", () => {
    const a = makeBody({ id: "a", x: 0, y: 0 });
    const b = makeBody({ id: "b", x: 200, y: 200 });
    const after = stepPhysics([a, b], 0.001, FLOOR, W);
    // 重力で y は微増するが x は不変
    expect(after[0].x).toBeCloseTo(a.x, 6);
    expect(after[1].x).toBeCloseTo(b.x, 6);
  });

  it("両方 settled の対は衝突処理がスキップされる（位置不変）", () => {
    const a = makeBody({
      id: "a",
      x: 100,
      y: FLOOR - 24,
      width: 60,
      height: 24,
      settled: true,
      settleFrames: SLEEP_FRAMES,
    });
    const b = makeBody({
      id: "b",
      x: 130, // overlapping a
      y: FLOOR - 24,
      width: 60,
      height: 24,
      settled: true,
      settleFrames: SLEEP_FRAMES,
    });
    const after = stepPhysics([a, b], DT, FLOOR, W);
    expect(after[0].x).toBe(a.x);
    expect(after[1].x).toBe(b.x);
  });
});

describe("stepPhysics detach", () => {
  it("detached body は重力・衝突対象外", () => {
    const b = makeBody({ x: 100, y: 100, detached: true });
    const after = stepPhysics([b], DT, FLOOR, W);
    expect(after[0].x).toBe(100);
    expect(after[0].y).toBe(100);
    expect(after[0].vx).toBe(0);
    expect(after[0].vy).toBe(0);
  });
});

describe("applyShake", () => {
  it("非 detached body の settled を全て解除し、必ず上向き速度を加える", () => {
    const settled = Array.from({ length: 10 }, (_, i) =>
      makeBody({
        id: String(i),
        x: i * 30,
        y: FLOOR - 24,
        settled: true,
        settleFrames: SLEEP_FRAMES,
      }),
    );
    const after = applyShake(settled, 100, 400, seedRng(42));
    expect(after.every((b) => !b.settled)).toBe(true);
    expect(after.every((b) => b.vy < 0)).toBe(true); // 全て上向き
    expect(after.every((b) => b.settleFrames === 0)).toBe(true);
  });

  it("detached body は無視される", () => {
    const b = makeBody({ detached: true, settled: true, vx: 0, vy: 0 });
    const after = applyShake([b], 100, 400, seedRng(1));
    expect(after[0].vx).toBe(0);
    expect(after[0].vy).toBe(0);
    expect(after[0].settled).toBe(true);
  });
});

describe("wakeNeighbors", () => {
  it("AABB 1px インフレートで重なる settled を wake、離れた body は維持", () => {
    const target = makeBody({ id: "t", x: 50, y: 50, vy: 100 });
    const overlap = makeBody({
      id: "n",
      x: 80, // overlap with target
      y: 60,
      settled: true,
      settleFrames: SLEEP_FRAMES,
    });
    const far = makeBody({
      id: "f",
      x: 300,
      y: 300,
      settled: true,
      settleFrames: SLEEP_FRAMES,
    });
    const adjacent = makeBody({
      id: "p",
      // target.x+w = 110, this body x=110 → 1px インフレートで重なる
      x: 110,
      y: 50,
      settled: true,
      settleFrames: SLEEP_FRAMES,
    });
    const after = wakeNeighbors(target, [target, overlap, far, adjacent]);
    expect(after[1].settled).toBe(false);
    expect(after[2].settled).toBe(true);
    expect(after[3].settled).toBe(false);
  });

  it("非 settled body は変化させない", () => {
    const target = makeBody({ id: "t", x: 50, y: 50 });
    const moving = makeBody({ id: "m", x: 80, y: 60, settled: false });
    const after = wakeNeighbors(target, [target, moving]);
    expect(after[1].settled).toBe(false);
  });

  it("自分自身は触らない", () => {
    const target = makeBody({
      id: "t",
      x: 50,
      y: 50,
      settled: true,
      settleFrames: SLEEP_FRAMES,
    });
    const after = wakeNeighbors(target, [target]);
    expect(after[0].settled).toBe(true);
  });
});

describe("attach / detach", () => {
  it("detach は速度をゼロにし detached=true にする", () => {
    const b = makeBody({ vx: 100, vy: -50, rotationV: 30 });
    const d = detach(b);
    expect(d.detached).toBe(true);
    expect(d.vx).toBe(0);
    expect(d.vy).toBe(0);
    expect(d.rotationV).toBe(0);
  });

  it("attach は detached/settled を解除", () => {
    const b = makeBody({
      settled: true,
      detached: true,
      settleFrames: SLEEP_FRAMES,
    });
    const a = attach(b);
    expect(a.detached).toBe(false);
    expect(a.settled).toBe(false);
    expect(a.settleFrames).toBe(0);
  });
});

describe("hasUnsettled", () => {
  it("いずれかが unsettled なら true", () => {
    expect(
      hasUnsettled([
        makeBody({ id: "a", settled: true, settleFrames: SLEEP_FRAMES }),
        makeBody({ id: "b", settled: false }),
      ]),
    ).toBe(true);
  });

  it("全て settled or detached なら false", () => {
    expect(
      hasUnsettled([
        makeBody({ id: "a", settled: true, settleFrames: SLEEP_FRAMES }),
        makeBody({ id: "b", settled: false, detached: true }),
      ]),
    ).toBe(false);
  });

  it("空配列は false", () => {
    expect(hasUnsettled([])).toBe(false);
  });
});

describe("placeFloorPreset", () => {
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

  it("seed 固定で決定論的に同じ結果を返す", () => {
    const a = placeFloorPreset(items, W, FLOOR, seedRng(7));
    const b = placeFloorPreset(items, W, FLOOR, seedRng(7));
    expect(a).toEqual(b);
  });

  it("全 body が settled で床より下にはみ出さない", () => {
    const bodies = placeFloorPreset(items, W, FLOOR, seedRng(7));
    for (const b of bodies) {
      expect(b.settled).toBe(true);
      expect(b.y + b.height).toBeLessThanOrEqual(FLOOR + 0.0001);
    }
  });

  it("空 items は空配列を返す", () => {
    expect(placeFloorPreset([], W, FLOOR, seedRng(7))).toEqual([]);
  });

  it("subKind 別 mass を反映する", () => {
    const bodies = placeFloorPreset(items, W, FLOOR, seedRng(7));
    expect(bodies[0].mass).toBe(SUBKIND_MASS["text-fragment"]);
    expect(bodies[1].mass).toBe(SUBKIND_MASS.scene);
    expect(bodies[2].mass).toBe(SUBKIND_MASS.snippet);
  });
});
