import type { BrowserMock } from "./browser-mock";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let browserMock: BrowserMock | null = null;
let browserMockReady: Promise<BrowserMock> | null = null;

function getBrowserMock(): Promise<BrowserMock> {
  if (browserMock) return Promise.resolve(browserMock);
  if (!browserMockReady) {
    browserMockReady = import("./browser-mock").then(async (m) => {
      browserMock = await m.createBrowserMock();
      return browserMock;
    });
  }
  return browserMockReady;
}

export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (isTauri) {
    const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
    return tauriInvoke<T>(cmd, args);
  }
  const mock = await getBrowserMock();
  return mock.invoke<T>(cmd, args);
}
