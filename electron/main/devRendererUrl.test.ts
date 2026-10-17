/**
 * devRendererUrl の単体テスト（K3/2「renderer の隔離」(e)。DA-1）。
 * packaged build（`app.isPackaged`）は起動の env `ELECTRON_RENDERER_URL` を無視する。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { appState } = vi.hoisted(() => ({
  appState: { isPackaged: false as unknown },
}));

vi.mock("electron", () => ({
  app: appState,
}));

import {
  getDevRendererUrl,
  resolveDevRendererUrl,
  shouldRegisterAppProtocol,
  shouldRegisterAppProtocolFor,
} from "./devRendererUrl.js";

const DEV_URL = "http://localhost:1430";

describe("resolveDevRendererUrl", () => {
  it("packaged は env を与えても undefined（production の app://bundle のまま）", () => {
    expect(
      resolveDevRendererUrl({
        isPackaged: true,
        env: { ELECTRON_RENDERER_URL: DEV_URL },
      }),
    ).toBeUndefined();
  });

  it("非 packaged は env の dev server の URL を返す", () => {
    expect(
      resolveDevRendererUrl({
        isPackaged: false,
        env: { ELECTRON_RENDERER_URL: DEV_URL },
      }),
    ).toBe(DEV_URL);
  });

  it("env がない・空なら undefined", () => {
    expect(
      resolveDevRendererUrl({ isPackaged: false, env: {} }),
    ).toBeUndefined();
    expect(
      resolveDevRendererUrl({
        isPackaged: false,
        env: { ELECTRON_RENDERER_URL: "" },
      }),
    ).toBeUndefined();
  });
});

describe("getDevRendererUrl", () => {
  beforeEach(() => {
    delete process.env.ELECTRON_RENDERER_URL;
  });

  it("process.env と app.isPackaged から決める", () => {
    process.env.ELECTRON_RENDERER_URL = DEV_URL;
    appState.isPackaged = false;
    expect(getDevRendererUrl()).toBe(DEV_URL);
    appState.isPackaged = true;
    expect(getDevRendererUrl()).toBeUndefined();
    delete process.env.ELECTRON_RENDERER_URL;
  });

  it("isPackaged が真偽値として読めない（未構成・例外）ときは packaged として扱い、env を無視する", () => {
    process.env.ELECTRON_RENDERER_URL = DEV_URL;
    appState.isPackaged = undefined;
    expect(getDevRendererUrl()).toBeUndefined();
    appState.isPackaged = "false";
    expect(getDevRendererUrl()).toBeUndefined();
    delete process.env.ELECTRON_RENDERER_URL;
  });
});

describe("shouldRegisterAppProtocol", () => {
  it("packaged は env があっても app://bundle を登録する", () => {
    expect(
      shouldRegisterAppProtocolFor({
        isPackaged: true,
        env: { ELECTRON_RENDERER_URL: DEV_URL },
      }),
    ).toBe(true);
    expect(shouldRegisterAppProtocolFor({ isPackaged: true, env: {} })).toBe(
      true,
    );
  });

  it("非 packaged は dev server の env があるときだけ登録しない", () => {
    expect(
      shouldRegisterAppProtocolFor({
        isPackaged: false,
        env: { ELECTRON_RENDERER_URL: DEV_URL },
      }),
    ).toBe(false);
    expect(shouldRegisterAppProtocolFor({ isPackaged: false, env: {} })).toBe(
      true,
    );
  });

  it("この process の判定は app.isPackaged と env を読む（読めない isPackaged は packaged 扱い）", () => {
    const saved = process.env.ELECTRON_RENDERER_URL;
    try {
      process.env.ELECTRON_RENDERER_URL = DEV_URL;
      appState.isPackaged = true;
      expect(shouldRegisterAppProtocol()).toBe(true);
      appState.isPackaged = undefined;
      expect(shouldRegisterAppProtocol()).toBe(true);
      appState.isPackaged = false;
      expect(shouldRegisterAppProtocol()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ELECTRON_RENDERER_URL;
      else process.env.ELECTRON_RENDERER_URL = saved;
    }
  });
});
