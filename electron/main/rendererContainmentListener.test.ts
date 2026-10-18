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

/**
 * 接続の試みの結果。listener が受けた直後に切った接続を、client が `connect` の後に
 * 閉じたと見るか、`connect` の前に閉じた（error／reset を含む）と見るかは OS で違う
 * （Linux は前者、Windows は後者がある）。どちらも「閉じられた」として扱う。
 */
type AttemptOutcome = "connected-then-closed" | "closed-before-connect";

interface Attempt {
  socket: net.Socket;
  /** `connect` を見たら true、その前に閉じたら false で解決する。 */
  settled: Promise<boolean>;
  /** 閉じたら、その前に `connect` を見たかどうかで解決する。 */
  closed: Promise<AttemptOutcome>;
  isClosed(): boolean;
}

function attempt(port: number): Attempt {
  const socket = net.connect({ host: "127.0.0.1", port });
  clients.push(socket);
  // client 側の error も握りつぶす（切断の試験のため）。error の後には必ず close が来る。
  socket.on("error", () => {});
  let connected = false;
  let isClosed = false;
  const settled = new Promise<boolean>((resolve) => {
    socket.once("connect", () => {
      connected = true;
      resolve(true);
    });
    socket.once("close", () => resolve(false));
  });
  const closed = new Promise<AttemptOutcome>((resolve) => {
    socket.once("close", () => {
      isClosed = true;
      resolve(connected ? "connected-then-closed" : "closed-before-connect");
    });
  });
  return { socket, settled, closed, isClosed: () => isClosed };
}

/** 保持されるはずの接続。`connect` の前に閉じたら試験の失敗。 */
async function connect(port: number): Promise<net.Socket> {
  const a = attempt(port);
  if (!(await a.settled)) throw new Error("closed before connect");
  return a.socket;
}

/** 試みを `concurrency` 本ずつ並べて出し、各組の全部が connect まで進むのを待つ。 */
async function connectInBatches(
  port: number,
  count: number,
  concurrency: number,
): Promise<net.Socket[]> {
  const sockets: net.Socket[] = [];
  for (let offset = 0; offset < count; offset += concurrency) {
    const size = Math.min(concurrency, count - offset);
    sockets.push(
      ...(await Promise.all(Array.from({ length: size }, () => connect(port)))),
    );
  }
  return sockets;
}

/**
 * server 側の `connection` を、listener の handler が走った後に観察する
 * （createServer の handler が先に登録されているので、この listener はその後に呼ばれる）。
 * `destroyedAtAccept` は listener が受けた直後（同じ handler の中）で切った数。
 */
function observeAccepts(listener: BlackholeListener): {
  seen: () => number;
  destroyedAtAccept: () => number;
  peak: () => number;
} {
  let seen = 0;
  let destroyedAtAccept = 0;
  let peak = 0;
  listener.server.on("connection", (socket) => {
    seen += 1;
    if (socket.destroyed) destroyedAtAccept += 1;
    peak = Math.max(peak, listener.activeConnections());
  });
  return {
    seen: () => seen,
    destroyedAtAccept: () => destroyedAtAccept,
    peak: () => peak,
  };
}

/**
 * 上限を超える接続の試みを一度に出し、すべてが受けた直後に閉じられることを確かめる。
 * client 側の見え方（connect の前か後か）には依らず、server 側で受けた handler の中で
 * 切られたこと、保持の時間（既定 5 秒）を待たずに閉じたことを見る。
 */
async function expectExcessClosedAtAccept(
  port: number,
  count: number,
  accepts: ReturnType<typeof observeAccepts>,
  expectedSeen: number,
): Promise<AttemptOutcome[]> {
  const started = Date.now();
  const excess = Array.from({ length: count }, () => attempt(port));
  const outcomes = await Promise.all(excess.map((a) => a.closed));
  // 保持の上限（5 秒）より十分に短い時間で全部が閉じた。
  expect(Date.now() - started).toBeLessThan(2000);
  for (const outcome of outcomes) {
    expect(["connected-then-closed", "closed-before-connect"]).toContain(
      outcome,
    );
  }
  // 閉じたのは listener が受けた直後に切ったから（OS が listen の backlog で断ったのではない）。
  await until(() => accepts.seen() === expectedSeen);
  expect(accepts.destroyedAtAccept()).toBe(count);
  return outcomes;
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
    const accepts = observeAccepts(listener);

    const total = 300;
    const cap = 256;
    // 上限までの 256 本は保持される。listen の backlog が OS で違っても断られないよう、
    // 64 本ずつ出す（どの 1 本も connect の前に閉じたら失敗）。
    const held = await connectInBatches(listener.port, cap, 64);
    for (const socket of held) socket.write("x");
    await until(() => listener.activeConnections() === cap);
    expect(accepts.seen()).toBe(cap);
    expect(accepts.destroyedAtAccept()).toBe(0);

    // 超過の 44 本を一度に出す。全部が受けた直後に切られる（保持の 5 秒を待たない）。
    await expectExcessClosedAtAccept(
      listener.port,
      total - cap,
      accepts,
      total,
    );
    await sleep(100);
    // 保持している接続は 256 のままで、超過の接続が既存の接続を押し出していない。
    expect(listener.activeConnections()).toBe(cap);
    expect(held.filter((socket) => socket.destroyed)).toEqual([]);
    expect(accepts.peak()).toBeLessThanOrEqual(cap);

    // 切断と接続を繰り返しても、枠が戻れば再び受けられ、listener は生きている。
    for (const socket of held) socket.destroy();
    await until(() => listener.activeConnections() === 0);
    const again = await connect(listener.port);
    await until(() => listener.activeConnections() === 1);
    expect(again.destroyed).toBe(false);
    expect(listener.server.listening).toBe(true);
    expect(accepts.peak()).toBeLessThanOrEqual(cap);
  });

  it("300 本を一度に出しても、保持は 256 を超えず、受けて保持しなかった分はすべて受けた直後に切る", async () => {
    const listener = await start(await freshModule());
    const accepts = observeAccepts(listener);
    const total = 300;
    const cap = 256;
    const attempts = Array.from({ length: total }, () =>
      attempt(listener.port),
    );
    // どの試みも connect か close のどちらかに決まる（OS が backlog で断った分は close）。
    await Promise.all(attempts.map((a) => a.settled));
    // client が保持中と見る接続が落ち着く（listener の handler の中の destroy が届く）まで待つ。
    await until(
      () =>
        attempts.filter((a) => !a.isClosed()).length ===
        listener.activeConnections(),
      2000,
    );
    await sleep(100);
    const open = attempts.filter((a) => !a.isClosed()).length;
    expect(listener.activeConnections()).toBe(open);
    expect(open).toBeLessThanOrEqual(cap);
    expect(accepts.peak()).toBeLessThanOrEqual(cap);
    // listener が受けた分のうち、保持しなかった分はすべて受けた handler の中で切っている。
    expect(accepts.seen() - accepts.destroyedAtAccept()).toBe(open);
    // 受けた数が上限を超えたなら、保持は上限ちょうど（超過の分だけが切られた）。
    if (accepts.seen() > cap) expect(open).toBe(cap);
    expect(listener.server.listening).toBe(true);
  });

  it("小さい上限を指定すると、その数を超える接続を受けた直後に切る", async () => {
    const listener = await start(await freshModule(), { maxConnections: 3 });
    const accepts = observeAccepts(listener);
    const held = await connectInBatches(listener.port, 3, 3);
    for (const socket of held) socket.write("x");
    await until(() => listener.activeConnections() === 3);
    await expectExcessClosedAtAccept(listener.port, 5, accepts, 8);
    await sleep(50);
    expect(listener.activeConnections()).toBe(3);
    expect(held.filter((socket) => socket.destroyed)).toEqual([]);
    expect(accepts.peak()).toBeLessThanOrEqual(3);
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
