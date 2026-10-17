/**
 * WebRTC の外向き通信を構造的に塞げるかの試験（NIR-1 の Y-1 の続き）。乗っ取られた renderer 相当の
 * JS として、RTCPeerConnection の iceServers に stun／stuns／turn（udp／tcp）／turns を渡す。
 * `webrtc-block-probe-main.mjs` が `webContents.executeJavaScript` で実行する。
 *
 * 引数: globalThis.__probe = { nonce, ports: { p, q, r, s, t }, lan, quick }
 *   p: 127.0.0.1 の canary（名前の host もここへ解決される）／q: 127.0.0.1 の別 port の canary
 *   r: 127.0.0.2 の canary／s: [::1] の canary／t: LAN の IPv4 の canary
 * 戻り値: Promise<Array<{id, outcome, startedAt, endedAt}>>
 */
(async () => {
  const { nonce, ports, lan, quick } = globalThis.__probe;
  const results = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = async (id, fn, ms = 4000) => {
    const startedAt = Date.now();
    let outcome;
    try {
      outcome = String(
        await Promise.race([fn(), wait(ms).then(() => "timeout")]),
      );
    } catch (error) {
      outcome = `error:${error?.name ?? "Error"}:${String(error?.message ?? "").slice(0, 120)}`;
    }
    await wait(300);
    results.push({ id, outcome, startedAt, endedAt: Date.now() });
  };

  // host の形ごとの (host, port)。name は *.probe.test（resolver rules で 127.0.0.1 へ解決される）。
  const hostFor = (form, id) =>
    ({
      name: [`${id}-${nonce}.probe.test`, ports.p],
      allowed: [`allowed-${id}-${nonce}.probe.test`, ports.q],
      lo4: ["127.0.0.1", ports.q],
      lo4b: ["127.0.0.2", ports.r],
      lo6: ["[::1]", ports.s],
      lan: [lan, ports.t],
      lo4n: ["127.0.0.1", ports.p],
      allowedp: [`allowed-${id}-${nonce}.probe.test`, ports.p],
      ext: [`ext-${id}-${nonce}.blocked.invalid`, 443],
    })[form];
  const urlsFor = (proto, h, port) =>
    ({
      stun: `stun:${h}:${port}`,
      stuns: `stuns:${h}:${port}`,
      "turn-udp": `turn:${h}:${port}?transport=udp`,
      "turn-tcp": `turn:${h}:${port}?transport=tcp`,
      turns: `turns:${h}:${port}`,
      "turns-tcp": `turns:${h}:${port}?transport=tcp`,
    })[proto];

  const rtcAttempt = async (RTC, proto, h, port, extra = {}) => {
    const server = { urls: urlsFor(proto, h, port) };
    if (proto.startsWith("turn")) {
      server.username = "SECRET-user";
      server.credential = "SECRET-cred";
    }
    const pc = new RTC({ iceServers: [server], ...extra });
    pc.createDataChannel("probe");
    await pc.setLocalDescription(await pc.createOffer());
    await wait(1700);
    const state = pc.iceGatheringState;
    pc.close();
    return `gathering:${state}`;
  };

  // ── 対照 ─────────────────────────────────────────────────────────────
  await settle("control.same-origin-fetch", async () => {
    const res = await fetch("/index.html");
    return `status:${res.status}`;
  });
  // 通常の http の fetch（CSP の connect-src で止まる。net 層まで届かない）。proxy の効きの対照は別に出す。
  await settle("control.bundled-worker", () =>
    new Promise((resolve) => {
      try {
        const w = new Worker("/assets/probe-worker.js");
        w.onmessage = (e) => resolve(String(e.data));
        w.onerror = () => resolve("worker-error");
        w.postMessage("x");
      } catch (e) {
        resolve(`throw:${e.name}`);
      }
    }),
  );
  await settle("control.rtc-defined", async () => typeof RTCPeerConnection);

  // ── main world の全 variant ───────────────────────────────────────────
  const protos = ["stun", "stuns", "turn-udp", "turn-tcp", "turns", "turns-tcp"];
  const forms = quick
    ? ["name", "lo4"]
    : ["name", "allowed", "allowedp", "ext", "lo4", "lo4b", "lo6", "lan"];
  for (const form of forms) {
    for (const proto of protos) {
      const id = `main.${proto}.${form}`;
      const [h, port] = hostFor(form, `${proto.replace(/[^a-z]/g, "")}${form}`);
      await settle(id, () => rtcAttempt(RTCPeerConnection, proto, h, port));
    }
  }

  // ── 攻撃者が作る remote candidate（iceServers を使わない経路）への connectivity check ──
  const remoteCandidate = async (RTC, line) => {
    const pc = new RTC({});
    pc.createDataChannel("probe");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    let sdp = offer.sdp.replace("a=setup:actpass", "a=setup:active");
    sdp = sdp.replace(/(\r?\n)?$/, "\r\n") + "";
    // m=application の section の末尾に candidate を足す
    sdp = sdp.replace(/(a=sctp-port:\d+\r\n)/, `$1a=ice-ufrag:abcd\r\na=ice-pwd:0123456789012345678901234\r\n${line}\r\n`);
    try {
      await pc.setRemoteDescription({ type: "answer", sdp });
    } catch (e) {
      pc.close();
      return `setRemoteDescription-failed:${e.name}`;
    }
    await wait(2200);
    const st = pc.iceConnectionState;
    pc.close();
    return `ice:${st}`;
  };
  for (const [form, ip, port] of [
    ["lo4", "127.0.0.1", ports.q],
    ["lan", lan, ports.t],
  ]) {
    await settle(`main.remote-candidate-udp.${form}`, () =>
      remoteCandidate(RTCPeerConnection, `a=candidate:1 1 udp 2113937151 ${ip} ${port} typ host`), 6000);
    await settle(`main.remote-candidate-tcp.${form}`, () =>
      remoteCandidate(RTCPeerConnection, `a=candidate:2 1 tcp 1518280447 ${ip} ${port} typ host tcptype passive`), 6000);
  }

  // ── 新しい realm（iframe、about:blank、srcdoc、blob、window.open）──────────────
  const realmRtc = async (id, getWindow, forms2 = ["name", "lo4"]) => {
    for (const form of forms2) {
      for (const proto of ["turn-tcp", "turns", "stun"]) {
        const [h, port] = hostFor(form, `r${id.replace(/[^a-z]/g, "")}${proto.replace(/[^a-z]/g, "")}${form}`);
        await settle(`realm.${id}.${proto}.${form}`, async () => {
          const w = await getWindow();
          if (!w) return "no-window";
          if (typeof w.RTCPeerConnection === "undefined") return "rtc-undefined";
          return rtcAttempt(w.RTCPeerConnection, proto, h, port);
        });
      }
    }
  };
  const mkFrame = async (attrs) => {
    const f = document.createElement("iframe");
    Object.assign(f, attrs);
    const loaded = new Promise((r) => (f.onload = r));
    document.body.append(f);
    await Promise.race([loaded, wait(1500)]);
    return f.contentWindow;
  };
  await realmRtc("iframe-html", () => mkFrame({ src: "/index.html" }));
  await realmRtc("iframe-blank", () => mkFrame({}));
  await realmRtc("iframe-srcdoc", () => mkFrame({ srcdoc: "<p>x</p>" }));
  await realmRtc("iframe-json", () => mkFrame({ src: "/assets/data.json" }), ["name"]);
  await realmRtc("iframe-notfound", () => mkFrame({ src: "/assets/nope.js" }), ["name"]);
  await realmRtc("iframe-blob", () =>
    mkFrame({
      src: URL.createObjectURL(new Blob(["<p>b</p>"], { type: "text/html" })),
    }),
    ["name"],
  );
  await realmRtc("window-open", async () => window.open("about:blank"), ["name"]);
  await settle("realm.worker-rtc-defined", () =>
    new Promise((resolve) => {
      const src = URL.createObjectURL(
        new Blob(["postMessage(typeof RTCPeerConnection)"], {
          type: "text/javascript",
        }),
      );
      try {
        const w = new Worker(src);
        w.onmessage = (e) => resolve(`worker:${e.data}`);
        w.onerror = () => resolve("worker-error");
      } catch (e) {
        resolve(`throw:${e.name}`);
      }
    }),
  );
  return results;
})()
