import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { judgeUpdateRouteProbe } from "./update-route-name-probe.mjs";

// H1 (b) の判定（CP-2b P3）。合成の記録で、期待から外れた記録が赤になることを確かめる。
// 実 Electron の実行は `update-route-name-probe.mjs`（ローカル専用）。

const OUTSIDE = "github-releases.githubusercontent.com";

function productRecord() {
  return {
    mode: "product",
    containmentStarted: true,
    cases: [
      { id: "request.loopback", outcome: "ok", value: "final" },
      {
        id: "request.outside",
        outcome: "error",
        message: "net::ERR_NAME_NOT_RESOLVED",
      },
      { id: "download.loopback", outcome: "ok", value: "final" },
      {
        id: "download.outside",
        outcome: "error",
        message: "net::ERR_NAME_NOT_RESOLVED",
      },
    ],
    resolveHost: { outcome: "error", message: "net::ERR_NAME_NOT_RESOLVED" },
    serverHits: [
      { path: "/loopback", host: "127.0.0.1:1" },
      { path: "/final", host: "127.0.0.1:1" },
      { path: "/outside", host: "127.0.0.1:1" },
    ],
  };
}

function controlRecord() {
  return {
    mode: "mapped-control",
    containmentStarted: null,
    cases: [
      { id: "request.loopback", outcome: "ok", value: "final" },
      { id: "request.outside", outcome: "ok", value: "final" },
      { id: "download.loopback", outcome: "ok", value: "final" },
      { id: "download.outside", outcome: "ok", value: "final" },
    ],
    resolveHost: { outcome: "ok", addresses: ["127.0.0.1"] },
    serverHits: [
      { path: "/final", host: `${OUTSIDE}:1` },
      { path: "/final", host: `${OUTSIDE}:1` },
    ],
  };
}

describe("update route name probe verdict (CP-2b P3, H1 b)", () => {
  it("passes the expected product and mapped-control records", () => {
    assert.deepEqual(judgeUpdateRouteProbe(productRecord(), controlRecord()), {
      pass: true,
      failures: [],
    });
  });

  it("fails when the outside name is reachable or fails for another reason in the product run", () => {
    const mutations = [
      (r) =>
        (r.cases[1] = { id: "request.outside", outcome: "ok", value: "final" }),
      (r) => (r.cases[3].message = "net::ERR_CONNECTION_REFUSED"),
      (r) => (r.cases[1].message = "probe-timeout"),
      (r) => (r.containmentStarted = false),
      (r) => r.serverHits.push({ path: "/final", host: `${OUTSIDE}:1` }),
      (r) => (r.resolveHost = { outcome: "ok", addresses: ["127.0.0.1"] }),
      (r) =>
        (r.cases[0] = {
          id: "request.loopback",
          outcome: "error",
          message: "x",
        }),
      (r) => r.cases.pop(),
      (r) => (r.mode = "mapped-control"),
    ];
    for (const mutate of mutations) {
      const product = productRecord();
      mutate(product);
      const verdict = judgeUpdateRouteProbe(product, controlRecord());
      assert.equal(verdict.pass, false, String(mutate));
    }
  });

  it("fails when the mapped control does not show the rules as the cause", () => {
    const mutations = [
      (r) =>
        (r.cases[3] = {
          id: "download.outside",
          outcome: "error",
          message: "net::ERR_NAME_NOT_RESOLVED",
        }),
      (r) => (r.serverHits = []),
      (r) =>
        (r.resolveHost = {
          outcome: "error",
          message: "net::ERR_NAME_NOT_RESOLVED",
        }),
      (r) => r.cases.shift(),
    ];
    for (const mutate of mutations) {
      const control = controlRecord();
      mutate(control);
      assert.equal(
        judgeUpdateRouteProbe(productRecord(), control).pass,
        false,
        String(mutate),
      );
    }
    assert.equal(judgeUpdateRouteProbe(productRecord(), null).pass, false);
    assert.equal(judgeUpdateRouteProbe(null, controlRecord()).pass, false);
  });
});
