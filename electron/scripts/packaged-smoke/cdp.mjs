/**
 * CP-2b P2 の packaged smoke の最小の CDP client（K3/3 (34)(i)。攻撃 JS を `Runtime.evaluate` で `app://bundle` の窓に注入する）。
 *
 * packaged の実行体は harness が選んだ port の `--remote-debugging-port`（Chromium の switch。製品は読まない）で起動し、
 * `/json/list` を poll して target を待つ（stderr を読まない。Windows の GUI の実行体でも同じ）。WebSocket は Node の global を使う
 * （依存を足さない）。待ちはすべて有限（呼出し側が上限を渡す）。
 */
import http from "node:http";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getJson(port, pathname, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathname, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/** `app://bundle/` の page の target か */
export function isAppBundlePage(target) {
  return target?.type === "page" && typeof target.url === "string" && target.url.startsWith("app://bundle/")
    && typeof target.webSocketDebuggerUrl === "string";
}

/**
 * target の出現を待つ。`isAlive()` が false になったら（実行体が先に終わったら）待たずに失敗する。
 * 戻り値: { target, waitedMs, polls }
 */
export async function waitForTarget(port, { timeoutMs, isAlive = () => true, predicate = isAppBundlePage, intervalMs = 250 }) {
  const started = Date.now();
  let polls = 0;
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    if (!isAlive()) throw new Error(`CDP の target の前に実行体が終了した（${lastError ?? "no response"}）`);
    polls += 1;
    try {
      const list = await getJson(port, "/json/list");
      const target = Array.isArray(list) ? list.find(predicate) : null;
      if (target) return { target, waitedMs: Date.now() - started, polls };
      lastError = `targets=${Array.isArray(list) ? list.map((entry) => `${entry.type}:${String(entry.url).slice(0, 40)}`).join(",") : "?"}`;
    } catch (error) {
      lastError = String(error?.message ?? error);
    }
    await sleep(intervalMs);
  }
  throw new Error(`CDP の target が ${timeoutMs} ms で現れない（${lastError ?? "no response"}）`);
}

/** 1 本の CDP の session。send は id で応答を待つ（上限つき） */
export async function connectCdp(webSocketDebuggerUrl, { timeoutMs = 10_000 } = {}) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("CDP の WebSocket が開かない")), timeoutMs);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP の WebSocket の error")); }, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    const entry = message.id != null ? pending.get(message.id) : null;
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`CDP ${entry.method}: ${message.error.message}`));
    else entry.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(`CDP ${entry.method}: socket closed`)); }
    pending.clear();
  });
  return {
    send(method, params = {}, { timeoutMs: callTimeout = 30_000 } = {}) {
      const id = nextId++;
      // 閉じた socket への send は応答が来ないので、timeout まで待たずに reject する
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`CDP ${method}: socket is not open`));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method}: ${callTimeout} ms で応答なし`)); }, callTimeout);
        pending.set(id, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      return new Promise((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        // 2 秒の上限の timer は close を見たら止める（残った timer で harness の終了を待たせない）
        const timer = setTimeout(resolve, 2000);
        socket.addEventListener("close", () => { clearTimeout(timer); resolve(); }, { once: true });
        try { socket.close(); } catch { clearTimeout(timer); resolve(); }
      });
    },
  };
}

/** `Runtime.evaluate` の値（例外は throw）。awaitPromise／returnByValue */
export async function evaluate(session, expression, { timeoutMs }) {
  const result = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, { timeoutMs });
  if (result?.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "exception";
    throw new Error(`Runtime.evaluate の例外: ${String(description).slice(0, 300)}`);
  }
  return result?.result?.value;
}
