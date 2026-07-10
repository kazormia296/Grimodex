import { describe, it, expect, vi, beforeEach } from "vitest";

// 疑似ディスク。get はレイテンシを挟み、直列化されていなければ 2 つの writer の
// read が交錯して lost update が起きる状況を再現する。
const disk: { current: Record<string, unknown> } = { current: {} };
const clone = (o: unknown) => JSON.parse(JSON.stringify(o));

const invokeMock = vi.fn(async (cmd: string, args?: { settings?: unknown }) => {
  if (cmd === "get_global_settings") {
    await new Promise((r) => setTimeout(r, 5));
    return clone(disk.current);
  }
  if (cmd === "save_global_settings") {
    await new Promise((r) => setTimeout(r, 1));
    disk.current = clone(args?.settings);
    return null;
  }
  throw new Error(`unexpected invoke: ${cmd}`);
});

vi.mock("@/lib/tauri", () => ({
  invoke: (...a: unknown[]) =>
    (invokeMock as unknown as (...x: unknown[]) => unknown)(...a),
}));

import { patchGlobalSettings } from "./globalSettings";

// テスト内の疑似 GlobalSettings は {a,b} だけを持つ簡易オブジェクト。
type Patch = Parameters<typeof patchGlobalSettings>[0];
const patch = (fn: (c: Record<string, number>) => Record<string, number>) =>
  patchGlobalSettings(fn as unknown as Patch);

describe("patchGlobalSettings", () => {
  beforeEach(() => {
    disk.current = { a: 0, b: 0 };
    invokeMock.mockClear();
  });

  it("重なり合う writer を直列化し、どの slice も失われない（lost update 防止）", async () => {
    // 2 つの writer をほぼ同時に発火。各自は自分の slice だけを触る。
    const p1 = patch((c) => ({ ...c, a: 1 }));
    const p2 = patch((c) => ({ ...c, b: 2 }));
    const [, r2] = await Promise.all([p1, p2]);

    // 直列化されていれば最終ディスクは両更新を含む。
    expect(disk.current).toEqual({ a: 1, b: 2 });
    // 後発 writer の read は先発の save 確定後に走るため結果も両 slice を持つ。
    expect(r2).toEqual({ a: 1, b: 2 });
  });

  it("read が失敗しても後続 writer は影響を受けない（チェーン継続）", async () => {
    invokeMock.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await expect(patch((c) => ({ ...c, a: 9 }))).rejects.toThrow("boom");

    await patch((c) => ({ ...c, b: 7 }));
    expect(disk.current).toEqual({ a: 0, b: 7 });
  });
});
