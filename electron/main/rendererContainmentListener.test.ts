/**
 * LS-1 の listener の頑健性の試験（K3/3 の Negative (30a) の「listener の存続」と
 * (31) の bytes の扱い。S1）。実 socket を使い、Node の client から RST、half-open、
 * 256 を超える大量の接続と切断を起こす。実 Electron（Chromium）での確認は (30b) で S3。
 */
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BlackholeListener } from "./rendererContainmentListener.js";

type ListenerModule = typeof import("./rendererContainmentListener.js");

const MAIN_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 二度目の start は拒否されるので、試験ごとに新しい module を得る。 */
async function freshModule(): Promise<ListenerModule> {
  vi.resetModules();
  return import("./rendererContainmentListener.js");
}

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    realSetTimeout(resolve, ms);
  });
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

async function until(
  condition: () => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("until: timeout");
    await sleep(5);
  }
}

const uncaught: unknown[] = [];
const onUncaught = (error: unknown): void => {
  uncaught.push(error);
};

let listeners: BlackholeListener[] = [];
let clients: net.Socket[] = [];

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    clients.push(socket);
    // client 側の error も握りつぶす（切断の試験のため）。
    socket.on("error", () => {});
    socket.once("connect", () => resolve(socket));
    socket.once("close", () => reject(new Error("closed before connect")));
  });
}

function closed(socket: net.Socket): Promise<void> {
  return socket.destroyed
    ? Promise.resolve()
    : new Promise((resolve) => socket.once("close", () => resolve()));
}

async function start(
  mod: ListenerModule,
  options?: Parameters<ListenerModule["startBlackholeListener"]>[0],
): Promise<BlackholeListener> {
  const listener = await mod.startBlackholeListener(options);
  listeners.push(listener);
  return listener;
}

beforeEach(() => {
  uncaught.length = 0;
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onUncaught);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const client of clients) client.destroy();
  clients = [];
  for (const listener of listeners) listener.server.close();
  listeners = [];
  await sleep(10);
  process.off("uncaughtException", onUncaught);
  process.off("unhandledRejection", onUncaught);
  expect(uncaught).toEqual([]);
});

describe("起動", () => {
  it("127.0.0.1 の ephemeral port で listen する", async () => {
    const listener = await start(await freshModule());
    const address = listener.server.address() as net.AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    expect(address.port).toBe(listener.port);
    expect(listener.port).toBeGreaterThan(0);
    expect(listener.activeConnections()).toBe(0);
  });

  it("二度目の start は拒否する（再 bind しない）", async () => {
    const mod = await freshModule();
    await start(mod);
    await expect(mod.startBlackholeListener()).rejects.toThrow(
      /already started/,
    );
  });

  it("listen の失敗は reject し、失敗の後も再試行しない", async () => {
    const mod = await freshModule();
    vi.spyOn(net.Server.prototype, "listen").mockImplementation(function (
      this: net.Server,
    ) {
      process.nextTick(() =>
        this.emit(
          "error",
          Object.assign(new Error("listen EADDRINUSE"), {
            code: "EADDRINUSE",
          }),
        ),
      );
      return this;
    });
    await expect(mod.startBlackholeListener()).rejects.toThrow(/EADDRINUSE/);
    await expect(mod.startBlackholeListener()).rejects.toThrow(
      /already started/,
    );
  });
});

describe("受けた bytes", () => {
  it("読み出して捨て、返事をしない（data の listener を付けず、書込みもしない）", async () => {
    const mod = await freshModule();
    const listener = await start(mod);
    const serverSockets: net.Socket[] = [];
    listener.server.on("connection", (socket) => serverSockets.push(socket));

    const client = await connect(listener.port);
    let received = 0;
    client.on("data", (chunk) => {
      received += chunk.length;
    });
    // SOCKS5 の挨拶の形と、それより大きい bytes を送る。
    client.write(Buffer.from([0x05, 0x01, 0x00]));
    client.write(Buffer.alloc(256 * 1024, 0x41));
    await until(() => serverSockets.length === 1);
    await until(() => serverSockets[0]!.bytesRead >= 256 * 1024);
    await sleep(100);

    expect(received).toBe(0);
    expect(serverSockets[0]!.bytesWritten).toBe(0);
    expect(serverSockets[0]!.listenerCount("data")).toBe(0);
    expect(listener.activeConnections()).toBe(1);
  });

  it("source は bytes を log・保存・書込みに渡さない", () => {
    const code = readFileSync(
      path.join(MAIN_DIR, "rendererContainmentListener.ts"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(
      /console\.|\.write\(|\.end\(|writeFile|appendFile/,
    );
    expect(code).not.toMatch(/on\(\s*["']data["']|once\(\s*["']data["']/);
    expect(code).not.toMatch(/process\.(env|argv)|from\s+["']electron["']/);
  });
});

describe("socket の切断", () => {
  it("RST を繰り返し受けても未処理例外にならず、listener は生きたまま枠が戻る", async () => {
    const listener = await start(await freshModule());
    for (let round = 0; round < 5; round += 1) {
      const batch = await Promise.all(
        Array.from({ length: 20 }, () => connect(listener.port)),
      );
      for (const socket of batch) {
        socket.write("x");
        socket.resetAndDestroy();
      }
    }
    await until(() => listener.activeConnections() === 0);
    // 生きている: 新しい接続を受けて保持する。
    const alive = await connect(listener.port);
    await until(() => listener.activeConnections() === 1);
    expect(alive.destroyed).toBe(false);
    expect(listener.server.listening).toBe(true);
  });

  it("half-close（FIN）を受けたら閉じて枠を空ける", async () => {
    const listener = await start(await freshModule());
    const sockets = await Promise.all(
      Array.from({ length: 10 }, () => connect(listener.port)),
    );
    await until(() => listener.activeConnections() === 10);
    for (const socket of sockets) socket.end();
    await until(() => listener.activeConnections() === 0);
    expect(listener.server.listening).toBe(true);
  });

  it("half-open（相手が何もしない）接続は保持の上限で切る", async () => {
    const mod = await freshModule();
    const listener = await start(mod, { holdMs: 150 });
    const client = await connect(listener.port);
    await until(() => listener.activeConnections() === 1);
    const started = Date.now();
    await closed(client);
    await until(() => listener.activeConnections() === 0);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(listener.server.listening).toBe(true);
  });

  it("保持は既定で 5 秒（引数が大きくても 5 秒に丸める）", async () => {
    const mod = await freshModule();
    expect(mod.LS1_MAX_HOLD_MS).toBe(5000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const listener = await start(mod, { holdMs: 600_000 });
    const client = await connect(listener.port);
    await until(() => listener.activeConnections() === 1);

    await vi.advanceTimersByTimeAsync(4999);
    await tick();
    expect(listener.activeConnections()).toBe(1);
    expect(client.destroyed).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await closed(client);
    await until(() => listener.activeConnections() === 0);
  });
});

describe("上限", () => {
  it("256 を超える大量の接続は受けた直後に切り、保持は 256 を超えない", async () => {
    const mod = await freshModule();
    expect(mod.LS1_MAX_CONCURRENT_CONNECTIONS).toBe(256);
    // 引数が確認済みの上限を超えても 256 に丸められる。
    const listener = await start(mod, { maxConnections: 1_000_000 });
    let peak = 0;
    listener.server.on("connection", () => {
      peak = Math.max(peak, listener.activeConnections());
    });

    const total = 300;
    const sockets = await Promise.all(
      Array.from({ length: total }, () => connect(listener.port)),
    );
    let closedCount = 0;
    for (const socket of sockets) {
      socket.once("close", () => {
        closedCount += 1;
      });
      socket.write("x");
    }
    // 超過の 44 本は受けた直後に切られる（保持の 5 秒を待たない）。
    await until(() => closedCount >= total - 256, 2000);
    await sleep(100);
    expect(closedCount).toBe(total - 256);
    expect(listener.activeConnections()).toBe(256);
    expect(peak).toBeLessThanOrEqual(256);

    // 切断と接続を繰り返しても、枠が戻れば再び受けられ、listener は生きている。
    for (const socket of sockets) socket.destroy();
    await until(() => listener.activeConnections() === 0);
    const again = await connect(listener.port);
    await until(() => listener.activeConnections() === 1);
    expect(again.destroyed).toBe(false);
    expect(listener.server.listening).toBe(true);
  });

  it("小さい上限を指定すると、その数を超える接続を受けた直後に切る", async () => {
    const listener = await start(await freshModule(), { maxConnections: 3 });
    const sockets = await Promise.all(
      Array.from({ length: 8 }, () => connect(listener.port)),
    );
    let closedCount = 0;
    for (const socket of sockets) {
      socket.once("close", () => {
        closedCount += 1;
      });
      socket.write("x");
    }
    await until(() => closedCount >= 5);
    await sleep(50);
    expect(closedCount).toBe(5);
    expect(listener.activeConnections()).toBe(3);
  });
});

describe("server の error と close", () => {
  it("server の error を握りつぶして継続する（終了せず、未処理例外にならず、onClosed も呼ばれない）", async () => {
    const onClosed = vi.fn();
    const listener = await start(await freshModule(), { onClosed });
    for (const code of ["EMFILE", "ECONNABORTED", "ENFILE"]) {
      expect(() =>
        listener.server.emit(
          "error",
          Object.assign(new Error(`accept ${code}`), { code }),
        ),
      ).not.toThrow();
    }
    expect(listener.server.listening).toBe(true);
    const client = await connect(listener.port);
    await until(() => listener.activeConnections() === 1);
    expect(client.destroyed).toBe(false);
    expect(onClosed).not.toHaveBeenCalled();
  });

  it("server が閉じたら onClosed を 1 度だけ呼ぶ（再 bind しない）", async () => {
    const onClosed = vi.fn();
    const mod = await freshModule();
    const listener = await start(mod, { onClosed });
    listener.server.close();
    await until(() => onClosed.mock.calls.length === 1);
    await sleep(20);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(listener.server.listening).toBe(false);
    await expect(mod.startBlackholeListener()).rejects.toThrow(
      /already started/,
    );
  });
});
