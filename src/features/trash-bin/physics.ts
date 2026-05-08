/**
 * ゴミ箱パネル物理シミュレーション (Matter.js バックエンド)。
 *
 * `TrashPhysicsEngine` は Matter.js の `Engine`/`World` を内包する stateful
 * ラッパー。座標は外向き API では `top-left`、内部では Matter 標準の
 * `center-of-mass` を扱う。
 */
import Matter from "matter-js";
import type { TrashSubKind } from "./types";

export const STIR_IMPULSE = 400;
export const STIR_IMPULSE_MAX = 1200;
export const DRAG_THRESHOLD_PX = 5;

/**
 * 全 subKind 共通の密度。質量差はサイズで表現する（デモと同方針）。
 * subKind 間で密度を変えるとスタック内の質量比が大きくなり、重い body が
 * 軽い body に着地した瞬間に軽い側が popcorn 化するため均一にする。
 */
const BODY_DENSITY = 0.001;

const WALL_THICKNESS = 200;
const FRICTION = 0.4;
const FRICTION_AIR = 0.01;
const RESTITUTION = 0;

export interface BodyState {
  id: string;
  x: number; // top-left
  y: number; // top-left
  width: number;
  height: number;
  rotation: number; // degrees
  isSleeping: boolean;
  isStatic: boolean;
}

export interface FloorPresetItem {
  id: string;
  subKind: TrashSubKind;
  size: { width: number; height: number };
}

export interface AddBodyOpts {
  id: string;
  subKind: TrashSubKind;
  size: { width: number; height: number };
  initial: "falling" | "settled-floor";
  /** falling 用にランダム x を決める。未指定時は engine.containerWidth を使う */
  containerWidth?: number;
  /** seed 可能 PRNG。テスト用 */
  rng?: () => number;
  /** 明示的に top-left 座標を指定（settled-floor 時に内部で使う） */
  x?: number;
  y?: number;
}

export class TrashPhysicsEngine {
  private engine: Matter.Engine;
  private world: Matter.World;
  private bodies = new Map<string, Matter.Body>();
  private sizes = new Map<string, { width: number; height: number }>();
  private walls: Matter.Body[] = [];
  private dragTracking = new Map<
    string,
    { cx: number; cy: number; t: number; vx: number; vy: number }
  >();
  private containerWidth = 0;
  private floorY = 0;

  constructor() {
    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: 1, scale: 0.001 },
      enableSleeping: true,
    });
    this.world = this.engine.world;
  }

  /** 容器サイズを設定。寸法が同じなら no-op、変わったら床と左右壁を再生成。 */
  setBounds(width: number, floorY: number) {
    if (width <= 0 || floorY <= 0) return;
    if (this.containerWidth === width && this.floorY === floorY) return;
    this.containerWidth = width;
    this.floorY = floorY;
    if (this.walls.length > 0) {
      Matter.World.remove(this.world, this.walls);
      this.walls = [];
    }
    const T = WALL_THICKNESS;
    const floor = Matter.Bodies.rectangle(
      width / 2,
      floorY + T / 2,
      width + 2 * T,
      T,
      { isStatic: true, friction: FRICTION, label: "__floor" },
    );
    const left = Matter.Bodies.rectangle(-T / 2, floorY / 2, T, floorY * 4, {
      isStatic: true,
      friction: FRICTION,
      label: "__wall_l",
    });
    const right = Matter.Bodies.rectangle(
      width + T / 2,
      floorY / 2,
      T,
      floorY * 4,
      { isStatic: true, friction: FRICTION, label: "__wall_r" },
    );
    this.walls = [floor, left, right];
    Matter.World.add(this.world, this.walls);
  }

  /** body を追加。返り値は追加直後の状態。 */
  addBody(opts: AddBodyOpts): BodyState {
    const { id, size, initial } = opts;
    const rng = opts.rng ?? Math.random;
    const w = size.width;
    const h = size.height;

    let cx: number;
    let cy: number;
    if (initial === "falling") {
      const cw = opts.containerWidth ?? this.containerWidth;
      const maxX = Math.max(0, cw - w);
      cx = (opts.x ?? rng() * maxX) + w / 2;
      cy = (opts.y ?? -h) + h / 2;
    } else {
      cx = (opts.x ?? 0) + w / 2;
      cy = (opts.y ?? this.floorY - h) + h / 2;
    }

    const body = Matter.Bodies.rectangle(cx, cy, w, h, {
      density: BODY_DENSITY,
      friction: FRICTION,
      frictionAir: FRICTION_AIR,
      restitution: RESTITUTION,
      angle: initial === "settled-floor" ? 0 : (rng() * 2 - 1) * 0.5,
      label: id,
    });
    if (initial === "falling") {
      Matter.Body.setAngularVelocity(body, (rng() * 2 - 1) * 0.08);
    }

    Matter.World.add(this.world, body);
    this.bodies.set(id, body);
    this.sizes.set(id, { width: w, height: h });

    if (initial === "settled-floor") {
      Matter.Sleeping.set(body, true);
    }

    return this.getState(id)!;
  }

  removeBody(id: string) {
    const body = this.bodies.get(id);
    if (!body) return;
    Matter.World.remove(this.world, body);
    this.bodies.delete(id);
    this.sizes.delete(id);
    this.dragTracking.delete(id);
    // 取り出された body の上に乗っていた sleeping bodies は支えを失っても
    // 自動で wake しないので明示的に起こす（重力で落下させるため）。
    this.wakeAll();
  }

  /** 動的 body を全て wake させる。pile の支えが消えた時に呼ぶ。 */
  private wakeAll() {
    for (const body of this.bodies.values()) {
      if (body.isStatic) continue;
      if (body.isSleeping) Matter.Sleeping.set(body, false);
    }
  }

  hasBody(id: string): boolean {
    return this.bodies.has(id);
  }

  ids(): string[] {
    return Array.from(this.bodies.keys());
  }

  /**
   * 物理ステップを進める。Matter.js の resolver 定数は 16.67ms で校正されており、
   * 1 ステップに大きな dt を渡すと安定性が落ちるため上限でクランプする。
   */
  step(dtMs: number) {
    if (dtMs <= 0) return;
    Matter.Engine.update(this.engine, Math.min(dtMs, 1000 / 60));
  }

  getState(id: string): BodyState | null {
    const body = this.bodies.get(id);
    const size = this.sizes.get(id);
    if (!body || !size) return null;
    return {
      id,
      x: body.position.x - size.width / 2,
      y: body.position.y - size.height / 2,
      width: size.width,
      height: size.height,
      rotation: (body.angle * 180) / Math.PI,
      isSleeping: body.isSleeping,
      isStatic: body.isStatic,
    };
  }

  forEachState(cb: (state: BodyState) => void) {
    for (const id of this.bodies.keys()) {
      const s = this.getState(id);
      if (s) cb(s);
    }
  }

  /** いずれかの動的 body が起きていれば true（rAF 継続判定用）。 */
  hasUnsettled(): boolean {
    for (const body of this.bodies.values()) {
      if (!body.isStatic && !body.isSleeping) return true;
    }
    return false;
  }

  /** 全 body を起こしてランダムな上向きインパルスを与える。 */
  shake(
    intensityX: number,
    intensityY: number,
    rng: () => number = Math.random,
  ) {
    for (const body of this.bodies.values()) {
      if (body.isStatic) continue;
      Matter.Sleeping.set(body, false);
      // 速度スケール: Matter は px/timestep。intensity*0.001 で控えめにした上で +- ランダム。
      const dvx = (rng() * 2 - 1) * intensityX * 0.001;
      const dvy = -Math.abs(intensityY) * (0.5 + rng() * 0.5) * 0.001;
      Matter.Body.setVelocity(body, {
        x: body.velocity.x + dvx,
        y: body.velocity.y + dvy,
      });
      Matter.Body.setAngularVelocity(
        body,
        body.angularVelocity + (rng() * 2 - 1) * 0.15,
      );
    }
  }

  /** ドラッグ開始: body を static にして手動で位置制御できるようにする。 */
  beginDrag(id: string) {
    const body = this.bodies.get(id);
    if (!body) return;
    Matter.Body.setStatic(body, true);
    this.dragTracking.delete(id);
    // 山の下からドラッグされた場合、上に乗っていた sleeping body は支えが
    // 動かない限り起きないので明示的に wake する。
    this.wakeAll();
  }

  /** ドラッグ中の位置更新。投擲速度のため最近の位置/時刻を追跡。 */
  dragTo(id: string, topLeftX: number, topLeftY: number) {
    const body = this.bodies.get(id);
    const size = this.sizes.get(id);
    if (!body || !size) return;
    const cx = topLeftX + size.width / 2;
    const cy = topLeftY + size.height / 2;
    const now =
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const prev = this.dragTracking.get(id);
    if (prev) {
      const dt = Math.max(1, now - prev.t);
      const stepRatio = 1000 / 60 / dt;
      const instVx = (cx - prev.cx) * stepRatio;
      const instVy = (cy - prev.cy) * stepRatio;
      this.dragTracking.set(id, {
        cx,
        cy,
        t: now,
        vx: prev.vx * 0.4 + instVx * 0.6,
        vy: prev.vy * 0.4 + instVy * 0.6,
      });
    } else {
      this.dragTracking.set(id, { cx, cy, t: now, vx: 0, vy: 0 });
    }
    Matter.Body.setPosition(body, { x: cx, y: cy });
  }

  /** ドラッグ終了: 動的に戻し、投擲速度を反映。 */
  endDrag(id: string) {
    const body = this.bodies.get(id);
    if (!body) return;
    const tracking = this.dragTracking.get(id);
    Matter.Body.setStatic(body, false);
    Matter.Sleeping.set(body, false);
    if (tracking) {
      Matter.Body.setVelocity(body, { x: tracking.vx, y: tracking.vy });
      Matter.Body.setAngularVelocity(body, tracking.vx * 0.005);
      this.dragTracking.delete(id);
    }
  }

  isStatic(id: string): boolean {
    const body = this.bodies.get(id);
    return body ? body.isStatic : false;
  }

  /**
   * ResizeObserver から呼ぶ: 動的 body を境界内にクランプ。位置補正後に
   * 速度・角速度を 0 リセットして wake する（重力で自然に再着地させる）。
   *
   * 何か wake な body が動いたら true を返す（rAF 起動判定用）。
   */
  clampBodies(): boolean {
    if (this.containerWidth <= 0 || this.floorY <= 0) return false;
    let anyAwakeMutated = false;
    for (const [id, body] of this.bodies.entries()) {
      if (body.isStatic) continue;
      const size = this.sizes.get(id)!;
      const origX = body.position.x;
      const origY = body.position.y;
      let nx: number;
      if (size.width >= this.containerWidth) {
        // 容器より幅広 body は左寄せ（テキストは左頭揃えなので冒頭を見せる）
        nx = size.width / 2;
      } else {
        const maxCx = this.containerWidth - size.width / 2;
        const minCx = size.width / 2;
        nx = Math.max(minCx, Math.min(maxCx, origX));
      }
      const maxCy = this.floorY - size.height / 2;
      const ny = Math.min(origY, maxCy);
      const mutated =
        Math.abs(nx - origX) > 0.001 || Math.abs(ny - origY) > 0.001;
      if (!mutated) continue;
      Matter.Body.setPosition(body, { x: nx, y: ny });
      Matter.Body.setVelocity(body, { x: 0, y: 0 });
      Matter.Body.setAngularVelocity(body, 0);
      Matter.Sleeping.set(body, false);
      anyAwakeMutated = true;
    }
    return anyAwakeMutated;
  }

  /**
   * 起動時に既存アイテムを「床に積まれた」状態で配置する。
   * 横方向重なりがあれば上に積む決定論的な簡易レイアウト。
   *
   * 1px の縦ギャップを入れて 0-penetration で配置する: スタックが起こされた瞬間に
   * 残留 overlap が impulse 化して popcorn 化するのを防ぐため。
   */
  placeFloorPreset(items: FloorPresetItem[], rng: () => number = Math.random) {
    if (this.containerWidth <= 0 || this.floorY <= 0) return;
    const STACK_GAP = 1;
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    for (const item of items) {
      const w = item.size.width;
      const h = item.size.height;
      const maxX = Math.max(0, this.containerWidth - w);
      const x = maxX > 0 ? rng() * maxX : 0;
      let restY = this.floorY - h;
      for (const p of placed) {
        const overlapX = Math.min(x + w, p.x + p.w) - Math.max(x, p.x);
        if (overlapX > 0) {
          const candidate = p.y - h - STACK_GAP;
          if (candidate < restY) restY = candidate;
        }
      }
      placed.push({ x, y: restY, w, h });
      this.addBody({
        id: item.id,
        subKind: item.subKind,
        size: { width: w, height: h },
        initial: "settled-floor",
        x,
        y: restY,
        rng,
      });
    }
  }

  destroy() {
    Matter.World.clear(this.world, false);
    Matter.Engine.clear(this.engine);
    this.bodies.clear();
    this.sizes.clear();
    this.dragTracking.clear();
    this.walls = [];
  }
}
