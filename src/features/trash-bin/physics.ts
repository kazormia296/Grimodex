/**
 * ゴミ箱パネルの物理シミュレーション（設計書 v3 §7）。
 *
 * 純関数ベース。`stepPhysics` などは入力配列を mutate せず新配列を返す。
 * DOM や React に依存しないため node 環境のテストで完結する。
 */

import type { TrashSubKind } from "./types";

export const GRAVITY = 680;
export const BOUNCE_DAMPING = 0.35;
export const WALL_DAMPING = 0.5;
export const FRICTION = 0.92;
export const SETTLE_THRESHOLD = 4;
export const COLLISION_REST = 0.4;
export const SLEEP_FRAMES = 10;
export const DRAG_THRESHOLD_PX = 5;
export const STIR_IMPULSE = 400;
export const STIR_IMPULSE_MAX = 1200;

export const SUBKIND_MASS: Record<TrashSubKind, number> = {
  "text-fragment": 1.0,
  "map-sticky": 1.5,
  foreshadow: 1.5,
  "codex-entry": 2.0,
  snippet: 2.0,
  "grid-chapter": 2.0,
  scene: 3.0,
};

export interface PhysicsBody {
  id: string;
  subKind: TrashSubKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  mass: number;
  rotation: number;
  rotationV: number;
  settled: boolean;
  detached: boolean;
  // 設計書からの追加フィールド: settle 連続フレームカウンタを body 自身に持たせる
  // ことで、stepPhysics を pure に保てる（外部 Map を持ち回さない）。
  settleFrames: number;
}

export interface CreateBodyOpts {
  id: string;
  subKind: TrashSubKind;
  containerWidth: number;
  size: { width: number; height: number };
  rng?: () => number;
  initial?: "falling" | "settled-floor";
  floorY?: number;
}

export function createBody(opts: CreateBodyOpts): PhysicsBody {
  const rng = opts.rng ?? Math.random;
  const w = opts.size.width;
  const h = opts.size.height;
  const mass = SUBKIND_MASS[opts.subKind] ?? 1.0;
  const maxX = Math.max(0, opts.containerWidth - w);
  const x = maxX > 0 ? rng() * maxX : 0;
  if (opts.initial === "settled-floor") {
    if (opts.floorY === undefined) {
      throw new Error(
        "createBody: floorY is required when initial='settled-floor'",
      );
    }
    return {
      id: opts.id,
      subKind: opts.subKind,
      x,
      y: opts.floorY - h,
      vx: 0,
      vy: 0,
      width: w,
      height: h,
      mass,
      rotation: (rng() * 2 - 1) * 8,
      rotationV: 0,
      settled: true,
      detached: false,
      settleFrames: SLEEP_FRAMES,
    };
  }
  return {
    id: opts.id,
    subKind: opts.subKind,
    x,
    y: -h,
    vx: (rng() * 2 - 1) * 40,
    vy: 0,
    width: w,
    height: h,
    mass,
    rotation: (rng() * 2 - 1) * 15,
    rotationV: (rng() * 2 - 1) * 60,
    settled: false,
    detached: false,
    settleFrames: 0,
  };
}

function clone(b: PhysicsBody): PhysicsBody {
  return { ...b };
}

export function stepPhysics(
  bodies: PhysicsBody[],
  dt: number,
  floorY: number,
  containerWidth: number,
): PhysicsBody[] {
  if (bodies.length === 0) return [];
  if (dt <= 0) return bodies.map(clone);

  const next = bodies.map(clone);

  // Phase 1: 重力・積分・壁反射・床反射
  for (const b of next) {
    if (b.detached || b.settled) continue;
    b.vy += (GRAVITY * dt) / b.mass;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.rotation += b.rotationV * dt;

    if (b.x < 0) {
      b.x = 0;
      b.vx = -b.vx * WALL_DAMPING;
    } else if (b.x + b.width > containerWidth) {
      b.x = Math.max(0, containerWidth - b.width);
      b.vx = -b.vx * WALL_DAMPING;
    }

    if (b.y + b.height > floorY) {
      b.y = floorY - b.height;
      b.vy = -b.vy * BOUNCE_DAMPING;
      b.vx *= FRICTION;
      b.rotationV *= FRICTION;
    }
  }

  // Phase 2: AABB ペア衝突（最大 100 body 想定の naive O(n²)）
  for (let i = 0; i < next.length; i++) {
    const a = next[i];
    if (a.detached) continue;
    for (let j = i + 1; j < next.length; j++) {
      const c = next[j];
      if (c.detached) continue;
      if (a.settled && c.settled) continue;

      const overlapX =
        Math.min(a.x + a.width, c.x + c.width) - Math.max(a.x, c.x);
      const overlapY =
        Math.min(a.y + a.height, c.y + c.height) - Math.max(a.y, c.y);
      if (overlapX <= 0 || overlapY <= 0) continue;

      const totalMass = a.mass + c.mass;
      // 衝突したら settle 解除（接触で拘束されている body も起こす）
      a.settled = false;
      c.settled = false;
      a.settleFrames = 0;
      c.settleFrames = 0;

      if (overlapX < overlapY) {
        const sign = a.x < c.x ? 1 : -1;
        a.x -= (sign * overlapX * c.mass) / totalMass;
        c.x += (sign * overlapX * a.mass) / totalMass;
        const rel = a.vx - c.vx;
        const impulse = (-(1 + COLLISION_REST) * rel) / totalMass;
        a.vx += impulse * c.mass;
        c.vx -= impulse * a.mass;
      } else {
        const sign = a.y < c.y ? 1 : -1;
        a.y -= (sign * overlapY * c.mass) / totalMass;
        c.y += (sign * overlapY * a.mass) / totalMass;
        const rel = a.vy - c.vy;
        const impulse = (-(1 + COLLISION_REST) * rel) / totalMass;
        a.vy += impulse * c.mass;
        c.vy -= impulse * a.mass;
      }
    }
  }

  // Phase 3: settle 判定
  // 床直上だけでなく、他の settled body の上に乗っている場合も settle 対象。
  // 速度閾値 + 連続フレーム数だけで判定するため、自然な「stack」が落ち着く。
  for (const b of next) {
    if (b.detached || b.settled) continue;
    const slow =
      Math.abs(b.vx) < SETTLE_THRESHOLD && Math.abs(b.vy) < SETTLE_THRESHOLD;
    if (slow) {
      b.settleFrames += 1;
      if (b.settleFrames >= SLEEP_FRAMES) {
        b.settled = true;
        b.vx = 0;
        b.vy = 0;
        b.rotationV = 0;
      }
    } else {
      b.settleFrames = 0;
    }
  }

  return next;
}

/**
 * 全 body に外力を加えて settled を解除する。
 * y 方向は常に上向きバイアス（vy が負方向に必ずシフトする）。
 */
export function applyShake(
  bodies: PhysicsBody[],
  ax: number,
  ay: number,
  rng: () => number = Math.random,
): PhysicsBody[] {
  return bodies.map((b) => {
    if (b.detached) return clone(b);
    return {
      ...b,
      vx: b.vx + (rng() * 2 - 1) * ax,
      vy: b.vy - Math.abs(ay) * (0.5 + rng() * 0.5),
      rotationV: b.rotationV + (rng() * 2 - 1) * 200,
      settled: false,
      settleFrames: 0,
    };
  });
}

/**
 * `target` と AABB が 1px インフレートで重なっている settled body を wake する。
 * 新規 body 着地時に下の積み重ねを起こす用途。
 */
export function wakeNeighbors(
  target: PhysicsBody,
  bodies: PhysicsBody[],
): PhysicsBody[] {
  const ax0 = target.x - 1;
  const ay0 = target.y - 1;
  const ax1 = target.x + target.width + 1;
  const ay1 = target.y + target.height + 1;
  return bodies.map((b) => {
    if (b.id === target.id) return clone(b);
    if (!b.settled) return clone(b);
    const overlap =
      ax0 < b.x + b.width && ax1 > b.x && ay0 < b.y + b.height && ay1 > b.y;
    if (!overlap) return clone(b);
    return { ...b, settled: false, settleFrames: 0 };
  });
}

export function attach(body: PhysicsBody): PhysicsBody {
  return { ...body, detached: false, settled: false, settleFrames: 0 };
}

export function detach(body: PhysicsBody): PhysicsBody {
  return { ...body, detached: true, vx: 0, vy: 0, rotationV: 0 };
}

export function hasUnsettled(bodies: PhysicsBody[]): boolean {
  for (const b of bodies) {
    if (!b.settled && !b.detached) return true;
  }
  return false;
}

export interface FloorPresetItem {
  id: string;
  subKind: TrashSubKind;
  size: { width: number; height: number };
}

/**
 * 起動時に既存アイテムを「床に積まれた」状態で配置する。
 * 簡易的に: 各アイテムをランダム x で配置し、既存配置との横方向重なりがあれば
 * 上に積む。決定論性のため `rng` を seedable に差し替え可能。
 */
export function placeFloorPreset(
  items: FloorPresetItem[],
  containerWidth: number,
  floorY: number,
  rng: () => number = Math.random,
): PhysicsBody[] {
  const bodies: PhysicsBody[] = [];
  for (const item of items) {
    const w = item.size.width;
    const h = item.size.height;
    const maxX = Math.max(0, containerWidth - w);
    const x = maxX > 0 ? rng() * maxX : 0;
    let restY = floorY - h;
    for (const placed of bodies) {
      const overlapX =
        Math.min(x + w, placed.x + placed.width) - Math.max(x, placed.x);
      if (overlapX > 0) {
        const candidate = placed.y - h;
        if (candidate < restY) restY = candidate;
      }
    }
    bodies.push({
      id: item.id,
      subKind: item.subKind,
      x,
      y: restY,
      vx: 0,
      vy: 0,
      width: w,
      height: h,
      mass: SUBKIND_MASS[item.subKind] ?? 1.0,
      rotation: (rng() * 2 - 1) * 8,
      rotationV: 0,
      settled: true,
      detached: false,
      settleFrames: SLEEP_FRAMES,
    });
  }
  return bodies;
}
