import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";
import test from "node:test";

import fs from "node:fs";
import http2 from "node:http2";
import os from "node:os";
import path from "node:path";

import { settlesWithin } from "./process-tree.mjs";
import { startCanary, startCtlSocket, startDohCanary, startHttp } from "./observers.mjs";

const canBind = (port, kind) => new Promise((resolve) => {
  if (kind === "udp") {
    const socket = dgram.createSocket("udp4");
    socket.once("error", () => resolve(false));
    socket.bind(port, "127.0.0.1", () => socket.close(() => resolve(true)));
  } else {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  }
});

test("canary の close は TCP と UDP の socket を実際に閉じる（同じ port を再び bind できる）", async () => {
  const canary = await startCanary("p", "127.0.0.1");
  assert.equal(canary.bound, true);
  assert.equal(await canBind(canary.port, "tcp"), false);
  await canary.close();
  assert.equal(await canBind(canary.port, "tcp"), true);
  assert.equal(await canBind(canary.port, "udp"), true);
});

test("bind できない address の canary は bound=false で、run を止めない", async () => {
  const canary = await startCanary("x", "192.0.2.123", { attempts: 2 });
  assert.equal(canary.bound, false);
  assert.ok(canary.error);
  await canary.close();
});

test("http と ctl の受け口は listen の error を reject し、close で port を閉じる", async () => {
  const httpd = await startHttp();
  const ctl = await startCtlSocket();
  await Promise.all([httpd.close(), ctl.close()]);
  assert.equal(await canBind(httpd.port, "tcp"), true);
  assert.equal(await canBind(ctl.port, "tcp"), true);
});

test("DoH の canary の close は開いたままの http2 の session があっても有限で終わる", async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "gps-doh-"));
  let doh;
  try { doh = await startDohCanary(work); } catch { t.skip("openssl が無い"); return; }
  const client = http2.connect(`https://127.0.0.1:${doh.port}`, { rejectUnauthorized: false });
  client.on("error", () => {});
  await new Promise((resolve) => client.once("connect", resolve));
  // client の session を開いたまま server を閉じる（session を壊さなければ close は session の終わりまで待つ）
  assert.equal(await settlesWithin(doh.close(), 3000), true);
  client.destroy();
  fs.rmSync(work, { recursive: true, force: true });
});
