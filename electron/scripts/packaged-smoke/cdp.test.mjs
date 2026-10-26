import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { connectCdp, evaluate, isAppBundlePage, waitForTarget } from "./cdp.mjs";

/** CDP の最小の模擬 server（/json/list と WebSocket の Runtime.evaluate）。Node の http の upgrade で WebSocket の frame を手で返す */
async function fakeCdp({ targets }) {
  const { createHash } = await import("node:crypto");
  const sockets = new Set();
  const server = createServer((req, res) => {
    if (req.url === "/json/list") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(targets(server.address().port))); return; }
    res.statusCode = 404; res.end();
  });
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", (data) => {
      const opcode = data[0] & 0x0f;
      if (opcode === 0x8) { socket.end(Buffer.from([0x88, 0x00])); return; }
      let length = data[1] & 0x7f; let offset = 2;
      if (length === 126) { length = data.readUInt16BE(2); offset = 4; }
      const mask = data.subarray(offset, offset + 4);
      const payload = Buffer.from(data.subarray(offset + 4, offset + 4 + length).map((byte, index) => byte ^ mask[index % 4]));
      const message = JSON.parse(payload.toString("utf8"));
      const reply = Buffer.from(JSON.stringify({ id: message.id, result: { result: { value: message.params.expression === "fail" ? undefined : 42 }, ...(message.params.expression === "fail" ? { exceptionDetails: { text: "boom" } } : {}) } }));
      const head = reply.length < 126 ? Buffer.from([0x81, reply.length]) : Buffer.from([0x81, 126, reply.length >> 8, reply.length & 0xff]);
      socket.write(Buffer.concat([head, reply]));
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }) };
}

test("target は app://bundle の page だけ。実行体が先に終われば待たずに失敗する", async () => {
  assert.equal(isAppBundlePage({ type: "page", url: "app://bundle/index.html", webSocketDebuggerUrl: "ws://x" }), true);
  assert.equal(isAppBundlePage({ type: "page", url: "devtools://x", webSocketDebuggerUrl: "ws://x" }), false);
  assert.equal(isAppBundlePage({ type: "service_worker", url: "app://bundle/sw.js", webSocketDebuggerUrl: "ws://x" }), false);
  await assert.rejects(waitForTarget(1, { timeoutMs: 5000, isAlive: () => false }), /終了した/);
});

test("evaluate は値を返し、例外を throw する。閉じた後の send は timeout を待たず reject、close の timer は残らない", async () => {
  const cdp = await fakeCdp({ targets: (port) => [{ type: "page", url: "app://bundle/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/1` }] });
  try {
    const { target } = await waitForTarget(cdp.port, { timeoutMs: 5000 });
    const session = await connectCdp(target.webSocketDebuggerUrl);
    assert.equal(await evaluate(session, "1 + 1", { timeoutMs: 5000 }), 42);
    await assert.rejects(evaluate(session, "fail", { timeoutMs: 5000 }), /boom/);
    await session.close();
    const started = Date.now();
    await assert.rejects(session.send("Runtime.evaluate", {}, { timeoutMs: 60_000 }), /not open/);
    assert.ok(Date.now() - started < 1000);
    assert.equal(process.getActiveResourcesInfo().filter((name) => name === "Timeout").length, 0);
  } finally {
    await cdp.close();
  }
});
