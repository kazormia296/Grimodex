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
 * subKind 別の密度（mass = density * area）。重い順: scene > codex/snippet > ...
 * 密度が低いと小さな impulse でも大きく動くので、Matter のデフォルト 0.001 より高めに振る。
 */
const SUBKIND_DENSITY: Record<TrashSubKind, number> = {
  "text-fragment": 0.002,
  "map-sticky": 0.0028,
  foreshadow: 0.0028,
  "codex-entry": 0.0036,
  snippet: 0.0036,
  "grid-chapter": 0.0036,
  scene: 0.0052,
};

const WALL_THICKNESS = 200;
const FRICTION = 0.4;
// 位置補正由来の velocity を素早く減衰させるため Matter デフォルト (0.01) より高め。
// 0.05 なら ~毎秒 5% 残留 → 補正速度が次フレームに積み上がらない。
const FRICTION_AIR = 0.05;
const RESTITUTION = 0;
/**
 * 速度上限（px/step、60fps 基準）。Matter の penetration 解決由来の
 * 視覚的な暴走を抑える。20 px/step ≒ 1200 px/sec で投擲には十分速い。
 */
const MAX_LINEAR_SPEED = 20;
const MAX_ANGULAR_SPEED = 0.5; // rad/step

/**
 * 侵入許容量（slop）。デフォルト 0.05px は本パネルのスケール（数十〜数百 px の body）
 * に対して厳しすぎ、わずかな rotation でも solver が爆発的な position 補正を行う。
 * 5px 程度まで許容することで補正→Verlet 統合経由の velocity 暴走を抑える。
 */
const BODY_SLOP = 5;

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
  /**
   * リサイズ直後の calm period: 全動的 body の速度を毎ステップ減衰させて
   * Matter solver の分離 impulse による爆発的カスケードを soak up する。
   * フレーム数は減速しながら 0 まで進む。
   */
  private calmFramesRemaining = 0;
  private static readonly CALM_FRAMES = 30;
  private static readonly CALM_DAMPING = 0.5;

  constructor() {
    this.engine = Matter.Engine.create({
      gravity: { x: 0, y: 1, scale: 0.0009 },
      enableSleeping: true,
      // スタック安定性のため position iterations を default(6) より上げる。
      // 残留 overlap が Verlet 統合経由で velocity 化し stack 内を伝播するのを抑える。
      positionIterations: 8,
      velocityIterations: 4,
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
    const { id, subKind, size, initial } = opts;
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
      density: SUBKIND_DENSITY[subKind] ?? 0.001,
      friction: FRICTION,
      frictionAir: FRICTION_AIR,
      restitution: RESTITUTION,
      slop: BODY_SLOP,
      // 初期 angle は控えめに: 大きい角度は隣接 body・床・壁との初期 overlap を生み、
      // solver が深い penetration を一気に補正 → Verlet 由来の velocity 暴走を引き起こす。
      angle: initial === "settled-floor" ? 0 : (rng() * 2 - 1) * 0.1,
      label: id,
    });
    if (initial === "falling") {
      Matter.Body.setAngularVelocity(body, (rng() * 2 - 1) * 0.05);
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
  }

  hasBody(id: string): boolean {
    return this.bodies.has(id);
  }

  ids(): string[] {
    return Array.from(this.bodies.keys());
  }

  /**
   * 物理ステップを進める。Matter.js は delta>16.67ms で安定性が落ちるため、
   * 大きな dt はサブステップに分割する（最大合計 33ms にクランプ）。
   * calm period 中は各サブステップ前に速度を減衰させて爆発を防ぐ。
   */
  step(dtMs: number) {
    if (dtMs <= 0) return;
    // 120Hz サブステップ化: stack 収束のため 1 ステップ dt を 8.33ms に。
    // 16.67ms より細かく解くことで、衝突 1 回あたり吸収するエネルギーが半分になり、
    // stack 内に伝播する Verlet 由来の velocity が大幅に減る。
    const SUB = 1000 / 120;
    let remaining = Math.min(dtMs, 33);
    while (remaining > SUB + 0.01) {
      this.applyCalmDamping();
      Matter.Engine.update(this.engine, SUB);
      this.clampMaxSpeed();
      remaining -= SUB;
    }
    if (remaining > 0) {
      this.applyCalmDamping();
      Matter.Engine.update(this.engine, remaining);
      this.clampMaxSpeed();
    }
  }

  /** Matter solver の penetration 解決による爆発的な速度を soft-cap。 */
  private clampMaxSpeed() {
    for (const body of this.bodies.values()) {
      if (body.isStatic || body.isSleeping) continue;
      const { x: vx, y: vy } = body.velocity;
      const speed = Math.hypot(vx, vy);
      if (speed > MAX_LINEAR_SPEED) {
        const k = MAX_LINEAR_SPEED / speed;
        Matter.Body.setVelocity(body, { x: vx * k, y: vy * k });
      }
      const av = body.angularVelocity;
      if (Math.abs(av) > MAX_ANGULAR_SPEED) {
        Matter.Body.setAngularVelocity(body, Math.sign(av) * MAX_ANGULAR_SPEED);
      }
    }
  }

  private applyCalmDamping() {
    if (this.calmFramesRemaining <= 0) return;
    const k = TrashPhysicsEngine.CALM_DAMPING;
    for (const body of this.bodies.values()) {
      if (body.isStatic || body.isSleeping) continue;
      Matter.Body.setVelocity(body, {
        x: body.velocity.x * k,
        y: body.velocity.y * k,
      });
      Matter.Body.setAngularVelocity(body, body.angularVelocity * k);
    }
    this.calmFramesRemaining -= 1;
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
   * ResizeObserver から呼ぶ: 動的 body を境界内にクランプ。
   *
   * 跳ね飛び対策の方針:
   * 1. 位置補正後に速度・角速度を 0 リセット
   * 2. 全 mutated body を wake（重力で自然に再着地・整列させる）
   * 3. calm period を起動 → 後続 step() で速度ダンピングを掛けて爆発を吸収
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
    if (anyAwakeMutated) {
      this.calmFramesRemaining = TrashPhysicsEngine.CALM_FRAMES;
    }
    return anyAwakeMutated;
  }

  /**
   * 起動時に既存アイテムを「床に積まれた」状態で配置する。
   * 横方向重なりがあれば上に積む決定論的な簡易レイアウト。
   */
  placeFloorPreset(items: FloorPresetItem[], rng: () => number = Math.random) {
    if (this.containerWidth <= 0 || this.floorY <= 0) return;
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
          const candidate = p.y - h;
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
