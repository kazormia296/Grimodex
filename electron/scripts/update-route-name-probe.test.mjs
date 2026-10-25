import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createSignalCleanup,
  judgeUpdateRouteProbe,
} from "./update-route-name-probe.mjs";

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
      (r) => r.cases.push({ id: "extra", outcome: "ok", value: "final" }),
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
      (r) => r.serverHits.pop(),
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

describe("update route name probe signal cleanup (CP-2b P3, H1 b)", () => {
  async function fakeChild({ closesOnTerm }) {
    const { EventEmitter } = await import("node:events");
    const child = new EventEmitter();
    Object.assign(child, { pid: 4242, exitCode: null, signalCode: null });
    const calls = [];
    const kill = (pid, signal) => {
      calls.push([pid, signal]);
      if (signal === "SIGTERM" && closesOnTerm) {
        setImmediate(() => child.emit("close", null, "SIGTERM"));
      }
    };
    return { child, calls, kill };
  }

  it("terminates the child's process group, removes the work dir and exits", async () => {
    const { child, calls, kill } = await fakeChild({ closesOnTerm: true });
    const removed = [];
    const exits = [];
    const state = { child, work: "/tmp/h1b-x" };
    const cleanup = createSignalCleanup(state, {
      kill,
      remove: (dir) => removed.push(dir),
      exit: (code) => exits.push(code),
    });
    const pending = cleanup("SIGTERM");
    // 待つ間に止める印が立っている（次の起動を始めない）。
    assert.equal(state.stopping, true);
    await pending;
    await cleanup("SIGTERM");
    assert.deepEqual(calls, [
      [-4242, "SIGTERM"],
      [-4242, "SIGKILL"],
    ]);
    assert.deepEqual(removed, ["/tmp/h1b-x"]);
    assert.deepEqual(exits, [143]);
  });

  it("kills the group after the grace period when the child does not close", async () => {
    const { child, calls, kill } = await fakeChild({ closesOnTerm: false });
    const exits = [];
    const cleanup = createSignalCleanup(
      { child, work: null },
      {
        kill,
        remove: () => assert.fail("no work dir"),
        exit: (code) => exits.push(code),
        graceMs: 10,
      },
    );
    await cleanup("SIGINT");
    assert.deepEqual(calls, [
      [-4242, "SIGTERM"],
      [-4242, "SIGKILL"],
    ]);
    assert.deepEqual(exits, [130]);
  });

  it("also kills a child that replaced the active one while waiting", async () => {
    const { child, calls, kill } = await fakeChild({ closesOnTerm: true });
    const state = { child, work: null };
    const cleanup = createSignalCleanup(state, {
      kill,
      remove: () => {},
      exit: () => {},
    });
    const pending = cleanup("SIGTERM");
    state.child = { pid: 5151, exitCode: null, signalCode: null };
    await pending;
    assert.deepEqual(calls, [
      [-4242, "SIGTERM"],
      [-4242, "SIGKILL"],
      [-5151, "SIGKILL"],
    ]);
  });
});
