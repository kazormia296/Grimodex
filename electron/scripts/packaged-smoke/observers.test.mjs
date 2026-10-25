import assert from "node:assert/strict";
import dgram from "node:dgram";
import net from "node:net";
import test from "node:test";

import { startCanary, startCtlSocket, startHttp } from "./observers.mjs";

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
