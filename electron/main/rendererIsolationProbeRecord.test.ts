/**
 * Y-1 の probe の記録の検査（K3/2「renderer の隔離とその固定」3、5。DA-1）。
 *
 * `node electron/scripts/renderer-isolation-probe.mjs` が実機（Electron）で採った記録
 * （electron/scripts/renderer-isolation-probe.record.json）と、DA-1 の前の挙動（HTML だけに
 * CSP を付ける）で検出できることを示す対照の記録（…legacy-control.record.json）を読む。
 *
 * - Electron の版上げで記録の版が package.json とずれたら失敗する。版上げの PR は
 *   probe をやり直して記録を更新する（K3/2 の版上げの規則）。
 * - WebRTC の ICE server を除く外向きの試みが 0 件であること、窓の title が固定されること、
 *   `<a download>` の攻撃が状態ファイルを変えないことを固定する。
 * - 未解決の finding（OPEN_FINDINGS）は空で、WebRTC の経路（`violationsViaWebRtc`）も 0 件であることを固定する。
 *   WebRTC の ICE server の finding（TURN の TCP／TLS の接続と名前解決。CSP は ICE server の URL を
 *   制限しない）は、NC-1（K3/3）が Main の network 層で塞いだ。記録の採取では probe の main が製品の
 *   NC-1 の module を `index.ts` と同じ順序で適用する（対照の legacy-control には当てない）。
 *   `own-data-read` の開放 commit は別（G-open の記録 `nc1-g-open/` を引く）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

interface ProbeRecord {
  schema: number;
  electron: string;
  variant: string;
  runCompleted: boolean;
  processSandbox: boolean;
  webPreferences: Record<string, unknown>;
  reachedNetwork: string[];
  violationsViaWebRtc: string[];
  violationsOutsideWebRtc: string[];
  canary: { secretsSeen: boolean; udpPackets: number };
  unattributed: {
    spellcheckerDictionary: string[];
    ipv6ReachabilityProbe: string[];
    other: string[];
  };
  title: {
    lockedStaysProduct: boolean;
    unlockedControlChanged: boolean;
    panelOpenOptionStaysProduct: boolean;
  };
  navigation: { newWindows: number; windowCount: number };
  downloads: {
    observed: Array<{
      savePathSetSynchronously: boolean;
      savePathInsideUserData: boolean;
    }>;
    results: Array<{
      id: string;
      stateFileUnchanged: boolean;
      destinationWritten: boolean | null;
    }>;
  };
  fileSystemAccessPicker: { stateFileUnchanged: boolean };
  renderer: Array<{ id: string; outcome: string }>;
}

function readJson<T>(relative: string): T {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"),
  ) as T;
}

const record = readJson<ProbeRecord>(
  "../scripts/renderer-isolation-probe.record.json",
);
const control = readJson<ProbeRecord>(
  "../scripts/renderer-isolation-probe.legacy-control.record.json",
);
const pkg = readJson<{ devDependencies: Record<string, string> }>(
  "../../package.json",
);

/**
 * 未解決の finding。空にすると下の試験は `violationsViaWebRtc` が 0 件であることを要求する。
 * WebRTC の ICE server の finding は NC-1（K3/3。Main の network 層で接続と名前解決を塞ぐ）で解消した。
 * 記録は製品の NC-1 の module を `renderer-isolation-probe-main.mjs` が適用して採り直した
 * （docs/plans/nir1-lane-decisions/nc1-decisions.md の DR-NC1-12 と実装後の追記）。
 */
const OPEN_FINDINGS: readonly string[] = [];

function outcome(r: ProbeRecord, id: string): string | undefined {
  return r.renderer.find((entry) => entry.id === id)?.outcome;
}

describe("Y-1 の記録: NC-1 の適用", () => {
  const main = readFileSync(
    fileURLToPath(
      new URL("../scripts/renderer-isolation-probe-main.mjs", import.meta.url),
    ),
    "utf8",
  );

  it("probe の main は製品の NC-1 の orchestrator を index.ts と同じ順序で当て、対照（legacy）には当てない", () => {
    expect(main).toContain('from "../main/rendererContainmentStartup.ts"');
    expect(main).toMatch(
      /legacyControl\s*\?\s*null\s*:\s*createRendererContainment/,
    );
    const order = [
      "containment?.appendResolverSwitch()",
      "registerSecurityHandlers(app)",
      "containment?.registerWebContentsPolicy()",
      "await containment.start()",
      "applySessionPermissionPolicy()",
    ].map((token) => main.indexOf(token));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("対照の記録は NC-1 なしの挙動で、CSP のない realm の外向きが網に届く（NC-1 の記録と同じ probe の検出力を示す）", () => {
    expect(control.variant).toBe("legacy-control");
    expect(control.reachedNetwork.length).toBeGreaterThan(0);
  });
});

describe("Y-1 の記録の版", () => {
  it("記録の Electron の版が package.json の版と一致する（版上げの PR は probe をやり直す）", () => {
    const pinned = pkg.devDependencies.electron;
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(record.electron).toBe(pinned);
    expect(control.electron).toBe(pinned);
  });

  it("probe は最後まで走り、本体と同じ隔離の設定で動いた", () => {
    expect(record.schema).toBe(1);
    expect(record.variant).toBe("product");
    expect(record.runCompleted).toBe(true);
    expect(record.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    });
  });
});

describe("Y-1 の記録: 外向きの試み", () => {
  it("WebRTC の ICE server を除く外向きの試みが 0 件", () => {
    expect(record.violationsOutsideWebRtc).toEqual([]);
    expect(record.canary.secretsSeen).toBe(false);
  });

  it("未解決の finding は WebRTC の経路だけ（OPEN_FINDINGS が空なら 0 件を要求する）", () => {
    if (OPEN_FINDINGS.length === 0) {
      expect(record.violationsViaWebRtc).toEqual([]);
    } else {
      expect(record.violationsViaWebRtc.length).toBeGreaterThan(0);
      for (const id of record.violationsViaWebRtc) {
        expect(id).toMatch(/^webrtc\.(turn-tcp|turns-tls)$|\.rtc$/);
      }
    }
    // UDP の STUN／TURN は canary に届いていない。
    expect(record.canary.udpPackets).toBe(0);
    expect(outcome(record, "webrtc.relay-only")).toContain("candidateTypes:");
  });

  it("marker のない外向きの観測は、spellchecker の辞書の取得と Chromium の IPv6 到達性の確認だけ", () => {
    expect(record.unattributed.other).toEqual([]);
    for (const host of record.unattributed.spellcheckerDictionary) {
      expect(host).toMatch(/gvt1\.com/);
    }
    expect(record.unattributed.ipv6ReachabilityProbe).toHaveLength(1);
  });

  it("fetch、XHR、WebSocket、sendBeacon、img、form、hint、worker、同一 origin の realm は網に届かない", () => {
    for (const id of [
      "net.fetch",
      "net.xhr",
      "net.websocket",
      "net.eventsource",
      "net.send-beacon",
      "net.img",
      "net.form-submit",
      "hint.dns-prefetch",
      "hint.preconnect",
      "hint.prefetch",
      "hint.prerender",
      "hint.preload",
      "worker.bundled-classic",
      "worker.bundled-module",
      "worker.blob",
      "worker.data-url",
      "worker.external",
      "realm.json",
      "realm.png",
      "realm.js",
      "realm.md",
      "realm.unknownext",
      "realm.notfound",
      "realm.encoded-traversal",
      "realm.html",
    ]) {
      expect(outcome(record, id), id).toBeDefined();
      expect(record.reachedNetwork, id).not.toContain(id);
    }
  });

  it("HTML 以外の応答と 404 の応答にも CSP が付く（realm の fetch の応答 header）", () => {
    for (const kind of [
      "json",
      "png",
      "js",
      "md",
      "unknownext",
      "notfound",
      "encoded-traversal",
      "html",
    ]) {
      expect(outcome(record, `realm.${kind}`), kind).toContain(
        '"cspHeader":true',
      );
    }
  });

  it("service worker は登録できず、blob／data の worker は CSP で止まり、同梱の force-layout worker は動く", () => {
    expect(outcome(record, "worker.service-worker")).toMatch(/^rejected:/);
    expect(outcome(record, "worker.blob")).toBe("onerror");
    expect(outcome(record, "worker.data-url")).toBe("onerror");
    expect(outcome(record, "worker.force-layout")).toBe("done:3");
  });

  it("permission は allowlist 外を拒否し、clipboard は利用者の操作なしに書けない", () => {
    for (const id of [
      "permission.geolocation",
      "permission.camera",
      "permission.microphone",
      "permission.clipboard-read",
      "permission.midi",
    ]) {
      expect(outcome(record, id), id).toBe("denied");
    }
    expect(outcome(record, "os.clipboard-write")).toMatch(/^error:/);
    // 通知は allowlist にある（開示の残余）。
    expect(outcome(record, "os.notification")).toBe("permission:granted");
  });
});

describe("Y-1 の記録: 窓の title、navigation、書出し", () => {
  it("restricted の間 document.title を変えても窓の title は製品名のまま（固定を外すと変わる対照つき）", () => {
    expect(record.title.lockedStaysProduct).toBe(true);
    expect(record.title.unlockedControlChanged).toBe(true);
  });

  it("grim:panel-open の title option を renderer が渡しても、固定中の窓の title は製品名", () => {
    expect(record.title.panelOpenOptionStaysProduct).toBe(true);
  });

  it("window.open は窓を増やさない", () => {
    expect(record.navigation.newWindows).toBe(1);
    expect(record.navigation.windowCount).toBe(1);
    expect(outcome(record, "net.window-open")).toBe("null");
  });

  it("`<a download>` は保存先を同期に profile data directory の外の temp に向け、状態ファイルを変えない", () => {
    expect(record.downloads.observed.length).toBeGreaterThan(0);
    for (const item of record.downloads.observed) {
      expect(item.savePathSetSynchronously).toBe(true);
      expect(item.savePathInsideUserData).toBe(false);
    }
    const attack = record.downloads.results.find(
      (r) => r.id === "download.attack-state-file",
    );
    expect(attack?.stateFileUnchanged).toBe(true);
    const control = record.downloads.results.find(
      (r) => r.id === "download.control-normal-destination",
    );
    expect(control?.destinationWritten).toBe(true);
    expect(record.fileSystemAccessPicker.stateFileUnchanged).toBe(true);
  });
});

describe("Y-1 の対照: DA-1 の前の挙動（HTML だけに CSP）では検出できる", () => {
  it("CSP のない同一 origin の realm と worker からの外向きの試みが網に届く", () => {
    expect(control.variant).toBe("legacy-control");
    for (const id of [
      "realm.json",
      "realm.png",
      "realm.notfound",
      "worker.bundled-classic",
    ]) {
      expect(control.reachedNetwork, id).toContain(id);
    }
    expect(control.violationsOutsideWebRtc.length).toBeGreaterThan(
      record.violationsOutsideWebRtc.length,
    );
  });
});
