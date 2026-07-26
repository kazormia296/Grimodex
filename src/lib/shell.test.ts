// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { electronBridge, isElectron } from "./shell";

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("isElectron", () => {
  it("window.grimodex 不在なら false", () => {
    expect(isElectron()).toBe(false);
  });

  it("window.grimodex が在れば true", () => {
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
    };
    expect(isElectron()).toBe(true);
  });
});

describe("electronBridge", () => {
  it("不在時は throw する（分岐バグの早期検出）", () => {
    expect(() => electronBridge()).toThrow(/window\.grimodex missing/);
  });

  it("在れば bridge 本体を返す", () => {
    const bridge = { shell: "electron" };
    (window as unknown as Record<string, unknown>).grimodex = bridge;
    expect(electronBridge()).toBe(bridge);
  });
});
