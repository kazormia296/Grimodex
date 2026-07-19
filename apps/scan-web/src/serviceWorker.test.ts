// @vitest-environment node
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

type WorkerListener = (event: Record<string, unknown>) => void;

async function loadWorker() {
  const listeners = new Map<string, WorkerListener>();
  const cache = {
    addAll: vi.fn(async (_urls: string[]) => undefined),
    put: vi.fn(async (_request: unknown, _response: Response) => undefined),
    keys: vi.fn(async () => [] as Request[]),
    delete: vi.fn(async (_request: Request) => true),
    match: vi.fn(
      async (_request: unknown) => undefined as Response | undefined,
    ),
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => [] as string[]),
    delete: vi.fn(async () => true),
    match: vi.fn(
      async (_request: unknown) => undefined as Response | undefined,
    ),
  };
  const self = {
    location: { origin: "https://try.grimodex.app" },
    clients: { claim: vi.fn(async () => undefined) },
    skipWaiting: vi.fn(async () => undefined),
    addEventListener: vi.fn((type: string, listener: WorkerListener) => {
      listeners.set(type, listener);
    }),
  };
  const fetchMock = vi.fn<typeof fetch>();
  const source = await readFile(
    new URL("../public/sw.js", import.meta.url),
    "utf8",
  );
  vm.runInNewContext(source, {
    self,
    caches,
    fetch: fetchMock,
    URL,
    Error,
    Promise,
    Set,
  });
  return { cache, caches, fetchMock, listeners };
}

describe("scan service worker", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("discovers and precaches Vite hashed JavaScript and CSS assets", async () => {
    const worker = await loadWorker();
    worker.fetchMock
      .mockResolvedValueOnce(
        new Response(
          '<link rel="stylesheet" href="/assets/app-def.css"><script type="module" src="/assets/app-abc.js"></script>',
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          '@font-face{font-family:"M PLUS 1";src:url("/assets/m-plus-1-japanese.woff2") format("woff2")}',
          { status: 200 },
        ),
      );
    let pending: Promise<unknown> | undefined;
    worker.listeners.get("install")?.({
      waitUntil(value: Promise<unknown>) {
        pending = value;
      },
    });
    await pending;

    expect(worker.cache.addAll).toHaveBeenCalledWith(
      expect.arrayContaining([
        "/",
        "/manifest.webmanifest",
        "/assets/app-abc.js",
        "/assets/app-def.css",
        "/assets/m-plus-1-japanese.woff2",
      ]),
    );
  });

  it("stores immutable font assets for later offline loads", async () => {
    const worker = await loadWorker();
    worker.fetchMock.mockResolvedValue(new Response("font", { status: 200 }));
    const request = {
      url: "https://try.grimodex.app/assets/m-plus-1-japanese.woff2",
      method: "GET",
      mode: "same-origin",
      cache: "default",
      headers: new Headers(),
    };
    let response: Promise<Response> | undefined;
    worker.listeners.get("fetch")?.({
      request,
      respondWith(value: Promise<Response>) {
        response = value;
      },
    });

    await expect(response).resolves.toHaveProperty("status", 200);
    await vi.waitFor(() => expect(worker.cache.put).toHaveBeenCalled());
    expect(worker.cache.put).toHaveBeenCalledWith(
      request,
      expect.any(Response),
    );
  });

  it("keeps caches immutable until activation removes older Scan builds", async () => {
    const worker = await loadWorker();
    worker.caches.keys.mockResolvedValue([
      "grimodex-scan-shell-old-build",
      "another-app-cache",
    ]);
    let pending: Promise<unknown> | undefined;
    worker.listeners.get("activate")?.({
      waitUntil(value: Promise<unknown>) {
        pending = value;
      },
    });
    await pending;

    expect(worker.caches.delete).toHaveBeenCalledOnce();
    expect(worker.caches.delete).toHaveBeenCalledWith(
      "grimodex-scan-shell-old-build",
    );
    expect(worker.caches.delete).not.toHaveBeenCalledWith("another-app-cache");
  });

  it("uses the app shell only for failed navigation requests", async () => {
    const worker = await loadWorker();
    const shell = new Response("app shell", { status: 200 });
    worker.fetchMock.mockRejectedValue(new Error("offline"));
    worker.cache.match.mockImplementation(async (request: unknown) =>
      request === "/index.html" ? shell : undefined,
    );

    const dispatch = (mode: string) => {
      let response: Promise<Response> | undefined;
      worker.listeners.get("fetch")?.({
        request: {
          url: "https://try.grimodex.app/assets/app-abc.js",
          method: "GET",
          mode,
          cache: "default",
          headers: new Headers(),
        },
        respondWith(value: Promise<Response>) {
          response = value;
        },
      });
      return response;
    };

    await expect(dispatch("same-origin")).rejects.toThrow("offline");
    await expect(dispatch("navigate")).resolves.toBe(shell);
  });

  it("uses cached assets and the app shell for transient non-ok responses", async () => {
    const worker = await loadWorker();
    const cachedAsset = new Response("cached asset", { status: 200 });
    const shell = new Response("app shell", { status: 200 });
    worker.fetchMock.mockResolvedValue(
      new Response("unavailable", { status: 503 }),
    );
    worker.cache.match.mockImplementation(async (request: unknown) => {
      if (request === "/index.html") return shell;
      if (
        typeof request === "object" &&
        request !== null &&
        (request as { url?: string }).url?.endsWith("/assets/app-abc.js")
      )
        return cachedAsset;
      return undefined;
    });

    const dispatch = (url: string, mode: string) => {
      let response: Promise<Response> | undefined;
      worker.listeners.get("fetch")?.({
        request: {
          url,
          method: "GET",
          mode,
          cache: "default",
          headers: new Headers(),
        },
        respondWith(value: Promise<Response>) {
          response = value;
        },
      });
      return response;
    };

    await expect(
      dispatch("https://try.grimodex.app/assets/app-abc.js", "same-origin"),
    ).resolves.toBe(cachedAsset);
    await expect(
      dispatch("https://try.grimodex.app/workspace", "navigate"),
    ).resolves.toBe(shell);
  });

  it("does not cache arbitrary query variants of build assets", async () => {
    const worker = await loadWorker();
    worker.fetchMock.mockResolvedValue(new Response("asset", { status: 200 }));
    let response: Promise<Response> | undefined;
    worker.listeners.get("fetch")?.({
      request: {
        url: "https://try.grimodex.app/assets/app-abc.js?variant=unbounded",
        method: "GET",
        mode: "same-origin",
        cache: "default",
        headers: new Headers(),
      },
      respondWith(value: Promise<Response>) {
        response = value;
      },
    });

    await expect(response).resolves.toHaveProperty("status", 200);
    expect(worker.cache.put).not.toHaveBeenCalled();
  });
});
