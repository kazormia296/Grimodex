/**
 * CP-2b P2 の packaged smoke の受け口（canary、Main 側の確認用の http と ctl、DoH の canary、UDP 5353 の受信 socket）。
 *
 * 形は `electron/scripts/webrtc-block-probe.mjs` の受け口と同じ（その file は import すると main を走らせるので、同じ形で書き直した。
 * cp2b-decisions DR-CP2B-P2-1）。違い: canary を bind できない宛先（例: macOS の 127.0.0.2）でも run を止めず、`bound: false` を
 * 記録して行を残す（区分は対照の観測で決まる。RJ。DR-CP2B-P2-3）。bind は loopback と LAN の IPv4 の ephemeral port だけ。
 */
import { execFileSync } from "node:child_process";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

/** loopback の ephemeral port で listen する。listen の error は reject（握りつぶさない） */
export function listenOn(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, host, () => { server.off("error", onError); resolve(); });
  });
}

const closeServer = (server) => new Promise((resolve) => { try { server.close(() => resolve()); } catch { resolve(); } });
const closeSocket = (socket) => new Promise((resolve) => { try { socket.close(() => resolve()); } catch { resolve(); } });

/** TCP と UDP を同じ port で受ける canary。bind できなければ bound=false（port は行の宛先に使う番号を別に持つ） */
export async function startCanary(label, addr, { v6 = false, attempts = 20 } = {}) {
  const hits = [];
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const tcp = net.createServer((socket) => {
      const at = Date.now();
      hits.push({ label, proto: "tcp-connect", at, head: "" });
      socket.on("data", (data) => hits.push({ label, proto: "tcp-data", at, head: data.toString("latin1").slice(0, 200) }));
      socket.on("error", () => {});
      socket.setTimeout(3000, () => socket.destroy());
    });
    try {
      await new Promise((resolve, reject) => { tcp.once("error", reject); tcp.listen(0, addr, resolve); });
    } catch (error) {
      lastError = error;
      await closeServer(tcp);
      break; // address そのものが使えない（EADDRNOTAVAIL など）。port を変えても同じ
    }
    const port = tcp.address().port;
    const udp = dgram.createSocket(v6 ? "udp6" : "udp4");
    const ok = await new Promise((resolve) => {
      udp.once("error", (error) => { lastError = error; resolve(false); });
      udp.bind(port, addr, () => resolve(true));
    });
    if (ok) {
      udp.on("message", (message) => hits.push({ label, proto: "udp", at: Date.now(), head: message.toString("latin1").slice(0, 100) }));
      return { label, addr, port, bound: true, error: null, hits, close: async () => { await closeServer(tcp); await closeSocket(udp); } };
    }
    await closeSocket(udp);
    await closeServer(tcp);
  }
  return { label, addr, port: null, bound: false, error: String(lastError?.code ?? lastError?.message ?? lastError), hits, close: async () => {} };
}

/** 空いている TCP の port を 1 つ選ぶ（CDP の port、閉じた proxy の port に使う） */
export async function freePort(host = "127.0.0.1") {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
  const { port } = server.address();
  await closeServer(server);
  return port;
}

/** probe の main の Main 側の確認（`main.net-fetch*` など）の受け口。canary ではない */
export async function startHttp() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ at: Date.now(), host: req.headers.host, url: String(req.url).slice(0, 60) });
    res.end("ok");
  });
  await listenOn(server);
  return { port: server.address().port, hits, close: () => closeServer(server) };
}

/** probe の main の Positive (9)(v) の確認（Main の Node から loopback の socket への接続）。canary ではない */
export async function startCtlSocket() {
  const hits = [];
  const server = net.createServer((socket) => {
    hits.push({ at: Date.now() });
    socket.on("error", () => {});
    socket.setTimeout(2000, () => socket.destroy());
  });
  await listenOn(server);
  return { port: server.address().port, hits, close: () => closeServer(server) };
}

/** DNS message の question（QNAME と QTYPE）を読む */
export function parseDnsQuestion(buffer) {
  let index = 12;
  const labels = [];
  while (index < buffer.length && buffer[index] !== 0) {
    const length = buffer[index];
    labels.push(buffer.subarray(index + 1, index + 1 + length).toString("latin1"));
    index += length + 1;
  }
  if (index + 4 >= buffer.length) throw new Error("short DNS question");
  return { name: labels.join("."), qtype: buffer.readUInt16BE(index + 1), end: index + 5 };
}

/** 問合せの header と question だけを残した NXDOMAIN の応答 */
export function nxdomainReply(buffer, end) {
  const out = Buffer.from(buffer.subarray(0, end));
  out[2] = 0x81; out[3] = 0x83; // QR, RD, RA, RCODE=3
  out.writeUInt16BE(0, 6); out.writeUInt16BE(0, 8); out.writeUInt16BE(0, 10);
  return out;
}

/**
 * DoH の canary（OS 非依存の名前の試みの観測。baseline の probe の main だけが使う。packaged では使えない）。
 * 自己署名の証明書は `openssl` で一時 dir に作る（有限の timeout）。作れなければ throw（その OS は観測の道具なし）。
 */
export async function startDohCanary(work) {
  const key = path.join(work, "doh.key");
  const crt = path.join(work, "doh.crt");
  const request = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "1", "-subj", "/CN=127.0.0.1"];
  // Windows の Git の openssl（MSYS）は `/CN=…` を path に変換しうるので、変換を止める env を渡す（他の OS では無害）
  const options = { stdio: "ignore", timeout: 30_000, env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } };
  try {
    execFileSync("openssl", [...request, "-addext", "subjectAltName=IP:127.0.0.1"], options);
  } catch {
    // `-addext` を持たない openssl（古い LibreSSL など）。probe の main は DoH の構成で証明書の検証を外すので SAN は要らない
    execFileSync("openssl", request, options);
  }
  const queries = [];
  const server = http2.createSecureServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt), allowHTTP1: true });
  server.on("request", (req, res) => {
    const finish = (buffer) => {
      try {
        const question = parseDnsQuestion(buffer);
        queries.push({ at: Date.now(), name: question.name, qtype: question.qtype });
        res.writeHead(200, { "content-type": "application/dns-message" });
        res.end(nxdomainReply(buffer, question.end));
      } catch {
        res.writeHead(400);
        res.end();
      }
    };
    if (req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => finish(Buffer.concat(chunks)));
    } else {
      finish(Buffer.from(new URL(req.url, "https://x").searchParams.get("dns") ?? "", "base64url"));
    }
  });
  // http2 の server の close は session が閉じるまで待つ（closeAllConnections は http2 に無い）。session を持って壊す
  const sessions = new Set();
  server.on("session", (session) => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
  server.on("connection", (socket) => { sessions.add(socket); socket.once("close", () => sessions.delete(socket)); });
  await listenOn(server);
  return {
    port: server.address().port,
    queries,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      for (const entry of sessions) { try { entry.destroy(); } catch { /* 閉じている */ } }
    }),
  };
}

/**
 * `.local` の観測: UDP 5353 の multicast（224.0.0.251）の受信 socket。nonce を含む問合せだけを数える。
 * 参加できなければ joined=false（観測できない環境。K3/3 の `.local` の規則では「未検証」）。
 */
export async function startMdnsObserver(nonce, lan) {
  const packets = [];
  let all = 0;
  const state = { joined: false, error: null, iface: lan };
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  socket.on("error", (error) => { state.error = String(error?.message ?? error); });
  socket.on("message", (message) => {
    all += 1;
    if (message.toString("latin1").includes(nonce)) packets.push({ at: Date.now() });
  });
  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(5353, "0.0.0.0", () => { socket.off("error", reject); resolve(); });
    });
    socket.setMulticastLoopback(true);
    socket.addMembership("224.0.0.251", lan ?? undefined);
    state.joined = true;
  } catch (error) {
    state.error = String(error?.message ?? error);
  }
  return { state, packets, seenAll: () => all, close: () => closeSocket(socket) };
}
