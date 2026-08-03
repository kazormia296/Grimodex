import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { setPermissionRequestHandler, setPermissionCheckHandler } = vi.hoisted(
  () => ({
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  }),
);

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: vi.fn(),
  },
  session: {
    defaultSession: {
      setPermissionRequestHandler,
      setPermissionCheckHandler,
    },
  },
  shell: { openExternal: vi.fn() },
}));

import {
  applySessionPermissionPolicy,
  isAllowedRendererPermission,
  isTrustedRendererUrl,
} from "./security.js";

const savedRendererUrl = process.env.ELECTRON_RENDERER_URL;

beforeEach(() => {
  delete process.env.ELECTRON_RENDERER_URL;
  setPermissionRequestHandler.mockClear();
  setPermissionCheckHandler.mockClear();
});

afterEach(() => {
  if (savedRendererUrl === undefined) {
    delete process.env.ELECTRON_RENDERER_URL;
  } else {
    process.env.ELECTRON_RENDERER_URL = savedRendererUrl;
  }
});

describe("isTrustedRendererUrl", () => {
  it("production の app://bundle と panel URL を許可する", () => {
    expect(isTrustedRendererUrl("app://bundle/index.html")).toBe(true);
    expect(
      isTrustedRendererUrl("app://bundle/index.html?window=panel&panel=chat"),
    ).toBe(true);
  });

  it("development は ELECTRON_RENDERER_URL と同一 origin だけを許可する", () => {
    process.env.ELECTRON_RENDERER_URL = "http://localhost:1430";
    expect(isTrustedRendererUrl("http://localhost:1430/?window=panel")).toBe(
      true,
    );
    expect(isTrustedRendererUrl("http://localhost:1431/")).toBe(false);
    expect(isTrustedRendererUrl("https://example.com/")).toBe(false);
  });

  it("外部 app host と不正 URL を拒否する", () => {
    expect(isTrustedRendererUrl("app://other/index.html")).toBe(false);
    expect(isTrustedRendererUrl("not a url")).toBe(false);
  });
});

describe("isAllowedRendererPermission", () => {
  const trusted = {
    requestingUrl: "app://bundle/index.html",
    topLevelUrl: "app://bundle/index.html",
    isMainFrame: true,
  } as const;

  it("trusted main frame の notification と clipboard write を許可する", () => {
    expect(
      isAllowedRendererPermission({
        ...trusted,
        permission: "notifications",
      }),
    ).toBe(true);
    expect(
      isAllowedRendererPermission({
        ...trusted,
        permission: "clipboard-sanitized-write",
      }),
    ).toBe(true);
  });

  it("clipboard read、未知権限、subframe を拒否する", () => {
    expect(
      isAllowedRendererPermission({
        ...trusted,
        permission: "clipboard-read",
      }),
    ).toBe(false);
    expect(
      isAllowedRendererPermission({ ...trusted, permission: "media" }),
    ).toBe(false);
    expect(
      isAllowedRendererPermission({
        ...trusted,
        permission: "clipboard-sanitized-write",
        isMainFrame: false,
      }),
    ).toBe(false);
  });

  it("requesting frame または top-level が外部 origin なら拒否する", () => {
    expect(
      isAllowedRendererPermission({
        ...trusted,
        permission: "clipboard-sanitized-write",
        requestingUrl: "https://example.com/",
      }),
    ).toBe(false);
    expect(
      isAllowedRendererPermission({
        ...trusted,
        permission: "clipboard-sanitized-write",
        topLevelUrl: "https://example.com/",
      }),
    ).toBe(false);
  });
});

describe("applySessionPermissionPolicy", () => {
  it("request/check の両 handler を同じ policy へ接続する", () => {
    applySessionPermissionPolicy();

    expect(setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(setPermissionCheckHandler).toHaveBeenCalledTimes(1);

    const requestHandler = setPermissionRequestHandler.mock.calls[0]?.[0] as (
      webContents: { getURL(): string },
      permission: string,
      callback: (allowed: boolean) => void,
      details: { requestingUrl: string; isMainFrame: boolean },
    ) => void;
    const checkHandler = setPermissionCheckHandler.mock.calls[0]?.[0] as (
      webContents: { getURL(): string } | null,
      permission: string,
      requestingOrigin: string,
      details: { requestingUrl?: string; isMainFrame: boolean },
    ) => boolean;

    const trustedUrls = [
      "app://bundle/index.html",
      "app://bundle/index.html?window=panel&panel=chat",
    ];
    process.env.ELECTRON_RENDERER_URL = "http://localhost:1430";
    trustedUrls.push("http://localhost:1430/?window=panel");

    for (const url of trustedUrls) {
      const callback = vi.fn();
      requestHandler(
        { getURL: () => url },
        "clipboard-sanitized-write",
        callback,
        { requestingUrl: url, isMainFrame: true },
      );
      expect(callback).toHaveBeenCalledWith(true);
      expect(
        checkHandler(
          { getURL: () => url },
          "clipboard-sanitized-write",
          new URL(url).origin,
          { requestingUrl: url, isMainFrame: true },
        ),
      ).toBe(true);
    }

    expect(
      checkHandler(
        { getURL: () => "app://bundle/index.html" },
        "clipboard-read",
        "app://bundle",
        { requestingUrl: "app://bundle/index.html", isMainFrame: true },
      ),
    ).toBe(false);
  });
});
