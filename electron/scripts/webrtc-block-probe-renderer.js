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
      // 固定の sentinel 名（K3/3 の NC-1 の rules が 127.0.0.1 へ写す名前。攻撃者が TURN／STUN の host に書ける。TCP を止める層は proxy の 1 つ）
      sentinel: ["grimodex-rule-sentinel.invalid", ports.p],
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

  // ── 再読込・遷移の後の localhost の TURN／STUN（NC-1 の DA-1 が足す行。policy と proxy の持続）──
  // main が窓を再読込（persist=reload）または遷移（persist=nav）した後に、この script を persist つきで再実行する
  if (globalThis.__probe.persist) {
    const tag = globalThis.__probe.persist;
    for (const proto of ["stun", "turn-udp", "turn-tcp", "turns"]) {
      await settle(`main.${proto}.${tag}-localhost`, () => rtcAttempt(RTCPeerConnection, proto, "localhost", ports.p));
    }
    return results;
  }

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
  // K3/3 Negative (23) の「固定の sentinel 名 × STUN／STUNS／TURN-UDP／TURN-TCP／TURNS／TURNS-TCP」の 6 行。(29) の proxy を外した構成の検出カテゴリ
  if (globalThis.__probe.sentinel && !quick) forms.push("sentinel");
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

  // ── FQDN の remote candidate（K3/3 R15）: address が非 mDNS の FQDN。Chromium は名前を解決するが、接続は試みない ──
  // （閉じ込めなしでも canary への到達 0、ICE は ice:new のまま。名前の解決だけが観測できる。合否は RJ の「不活性の行」と NL）
  if (globalThis.__probe.fqdn) {
    const fq = (tag) => `rc${tag}-${nonce}.probe.test`;
    for (const [id, line] of [
      ["remote-candidate-udp.fqdn", `a=candidate:1 1 udp 2113937151 ${fq("u")} ${ports.q} typ host`],
      ["remote-candidate-tcp.fqdn", `a=candidate:2 1 tcp 1518280447 ${fq("t")} ${ports.q} typ host tcptype passive`],
      ["remote-candidate-tcp.fqdn-so", `a=candidate:3 1 tcp 1518280447 ${fq("s")} ${ports.q} typ host tcptype so`],
      ["remote-candidate-udp.fqdn-relay", `a=candidate:4 1 udp 41885439 ${fq("r")} ${ports.q} typ relay raddr 0.0.0.0 rport 0`],
      ["remote-candidate-udp.fqdn-srflx", `a=candidate:5 1 udp 1677729535 ${fq("f")} ${ports.q} typ srflx raddr 0.0.0.0 rport 0`],
    ]) {
      await settle(`main.${id}`, () => remoteCandidate(RTCPeerConnection, line), 6000);
    }
  }

  // ── `.local`（mDNS）の行（NC-1 の DA-1 が足す行）: dns-prefetch と TURN／STUN の `.local`。
  // 観測は runner の UDP 5353 の multicast の受信 socket（`mdnsQueries`）。判定は draft の `.local` の規則だけ。
  // 行 id は道具の classify が `mdns`（判定しない行）として扱う形（`local-name`）にする
  if (globalThis.__probe.local) {
    const lname = (tag) => `${tag}-${nonce}.local`;
    await settle("local-name.dns-prefetch", async () => {
      const l = document.createElement("link");
      l.rel = "dns-prefetch";
      l.href = `//${lname("dnspf")}`;
      document.head.append(l);
      await wait(900);
      return "link:dns-prefetch";
    }, 3000);
    for (const proto of ["stun", "turn-udp", "turn-tcp"]) {
      await settle(`local-name.${proto}`, () => rtcAttempt(RTCPeerConnection, proto, lname(proto.replace(/[^a-z]/g, "")), ports.p));
    }
  }

  // ── (30b) RTCPeerConnection の開閉の反復（NC-1 の listener の頑健性）──────────────
  // 同時 256 の上限を超える数の TURN-TCP の接続を、開閉を繰り返して起こす。上限超過の接続は Main の listener が受けた直後に切る。
  // 切断が続く間も canary への到達が 0（Chromium が DIRECT へ落ちない）で、窓が生きていること。
  // 行 id は道具の classify が TCP の行として扱う形（`main.turn-tcp.*`）にする: 合格 = canary 0 かつ listener への接続 1 以上
  if (globalThis.__probe.churn) {
    const dests = [
      `127.0.0.1:${ports.q}`, `127.0.0.1:${ports.p}`, `127.0.0.2:${ports.r}`, `[::1]:${ports.s}`,
      `${lan}:${ports.t}`, `localhost:${ports.p}`, `127.1:${ports.q}`, `0x7f.1:${ports.p}`,
    ];
    await settle("main.turn-tcp.churn", async () => {
      const t0 = Date.now();
      let opened = 0;
      while (Date.now() - t0 < 6000) {
        const batch = [];
        for (let i = 0; i < 50; i += 1) {
          const iceServers = dests.map((d) => ({ urls: `turn:${d}?transport=tcp`, username: "u", credential: "c" }));
          const pc = new RTCPeerConnection({ iceServers });
          pc.createDataChannel("churn");
          pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {});
          batch.push(pc);
          opened += 1;
        }
        await wait(700);
        for (const pc of batch) pc.close();
        await wait(100);
      }
      return `churn:${opened}`;
    }, 20000);
    // churn の後も新しい接続が blackhole へ向く（窓が生きている）
    await settle("main.turn-tcp.after-churn", () => rtcAttempt(RTCPeerConnection, "turn-tcp", "127.0.0.1", ports.q));
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

  // ── reviewer の追加行（K3/3 R15 の独立レビュー。大文字小文字、数値形式、pool／relay、setConfiguration、WebTransport）──
  if (globalThis.__probe.secx) {
    const names = ["GitHub.com", "GITHUB.COM", "gItHuB.cOm", "Release-Assets.GitHubUserContent.com", "LOCALHOST", "LocalHost", "Grimodex-Rule-Sentinel.INVALID", "github.com.", "GITHUB.COM."];
    for (const [i, h] of names.entries()) {
      for (const proto of ["turn-tcp", "stun", "turns"]) {
        await settle(`sx.${proto}.case${i}`, () => rtcAttempt(RTCPeerConnection, proto, h, ports.p));
      }
    }
    const lanParts = lan.split(".").map(Number);
    const lanDec = String(((lanParts[0] * 256 + lanParts[1]) * 256 + lanParts[2]) * 256 + lanParts[3]);
    const forms2 = { lanDec, lanHex: "0x" + Number(lanDec).toString(16), lo0: "0.0.0.0", lo7f1: "127.1", loHex: "0x7f.1", loMapped: "[::ffff:7f00:1]", lanMapped: `[::ffff:${lan}]`, lo6long: "[0:0:0:0:0:0:0:1]", lo6zone: "[::1%251]", llz: "[fe80::e45:bfe9:94f1:7281%25enp5s0]", llnz: "[fe80::e45:bfe9:94f1:7281]", llz2: "[fe80::e45:bfe9:94f1:7281%2]" };
    for (const [k, h] of Object.entries(forms2)) {
      const port = k.startsWith("lan") ? ports.t : (k === "lo6long" || k === "lo6zone" ? ports.s : (k.startsWith("ll") ? 3478 : ports.q));
      for (const proto of ["turn-tcp", "turns", "stun", "turn-udp"]) {
        await settle(`sx.${proto}.${k}`, () => rtcAttempt(RTCPeerConnection, proto, h, port));
      }
    }
    // pool と relay-only、複数 URL、setConfiguration、iceRestart
    await settle("sx.pool.turn-tcp.lo4", async () => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: `turn:127.0.0.1:${ports.q}?transport=tcp`, username: "u", credential: "c" }], iceCandidatePoolSize: 10 });
      await wait(1700); pc.close(); return "pool";
    });
    await settle("sx.relay.turns.lo4", () => rtcAttempt(RTCPeerConnection, "turns", "127.0.0.1", ports.q, { iceTransportPolicy: "relay" }));
    await settle("sx.multi-url.lo4", async () => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: [`stun:127.0.0.1:${ports.q}`, `turn:127.0.0.1:${ports.q}?transport=udp`, `turn:127.0.0.1:${ports.q}?transport=tcp`, `turns:127.0.0.1:${ports.q}`], username: "u", credential: "c" }] });
      pc.createDataChannel("x"); await pc.setLocalDescription(await pc.createOffer()); await wait(1700); pc.close(); return "multi";
    });
    await settle("sx.setconfiguration.turn-tcp.lo4", async () => {
      const pc = new RTCPeerConnection({});
      pc.createDataChannel("x"); await pc.setLocalDescription(await pc.createOffer()); await wait(500);
      pc.setConfiguration({ iceServers: [{ urls: `turn:127.0.0.1:${ports.q}?transport=tcp`, username: "u", credential: "c" }] });
      pc.restartIce(); await pc.setLocalDescription(await pc.createOffer({ iceRestart: true })); await wait(1700); pc.close(); return "setconf";
    });
    await settle("sx.setconfiguration.stun.lo4", async () => {
      const pc = new RTCPeerConnection({});
      pc.createDataChannel("x"); await pc.setLocalDescription(await pc.createOffer()); await wait(500);
      pc.setConfiguration({ iceServers: [{ urls: `stun:127.0.0.1:${ports.q}` }] });
      pc.restartIce(); await pc.setLocalDescription(await pc.createOffer({ iceRestart: true })); await wait(1700); pc.close(); return "setconf";
    });
    await settle("sx.webtransport.lo4", async () => {
      try { const wt = new WebTransport(`https://127.0.0.1:${ports.q}/x`); await Promise.race([wt.ready, wait(1500)]); } catch (e) { return `wt:${e.name}`; } return "wt";
    }, 4000);
    await settle("sx.webtransport.name", async () => {
      try { const wt = new WebTransport(`https://wt-${nonce}.dnsprobe.test/x`); await Promise.race([wt.ready, wait(1500)]); } catch (e) { return `wt:${e.name}`; } return "wt";
    }, 4000);
    // DedicatedWorker（同梱 script）で RTCPeerConnection が定義されているか
    await settle("sx.bundled-worker-rtc", () => new Promise((resolve) => {
      try { const w = new Worker("/assets/probe-worker.js"); w.onmessage = (e) => resolve(`w:${e.data}`); w.onerror = () => resolve("worker-error"); w.postMessage("rtc?"); } catch (e) { resolve(`throw:${e.name}`); }
    }));
  }
  return results;
})()
