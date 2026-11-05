import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_CAUSE_DEPTH,
  describeError,
  describeErrorChain,
  sanitizeMessage,
  waitUntilConnectionReady,
} from "./ir-error-record.mjs";

// 作った値だけ（作品の本文に由来しない）。
const BODY = "Once upon a time the secret body text appeared";

test("sanitizeMessage：params 以降を切り捨てる（drizzle の Failed query）", () => {
  const message = `Failed query: SELECT id FROM scenes WHERE id = ?\nparams: ${BODY}`;
  const out = sanitizeMessage(message);
  assert.ok(out.startsWith("Failed query: SELECT id FROM scenes"));
  assert.ok(!out.includes("Once upon"));
  assert.ok(!out.includes("params"));
});

test("sanitizeMessage：大文字・空白つきの params: も切る", () => {
  assert.ok(!sanitizeMessage(`x PARAMS : ${BODY}`).includes("Once"));
});

test("sanitizeMessage：引用された断片を伏せる（JSON.parse／serde の形）", () => {
  const cases = [
    `Unexpected token 'O', "${BODY}" is not valid JSON`,
    `invalid type: string "${BODY}", expected a map`,
    `unterminated "${BODY}`,
    `got '${BODY}' here`,
  ];
  for (const message of cases) {
    const out = sanitizeMessage(message);
    assert.ok(!out.includes("Once upon"), out);
    assert.ok(out.includes("<q>"), out);
  }
  assert.equal(
    sanitizeMessage(`invalid type: string "${BODY}", expected a map`),
    'invalid type: string "<q>", expected a map',
  );
});

test("sanitizeMessage：英語の縮約の apostrophe は引用にしない", () => {
  assert.equal(
    sanitizeMessage("can't open: don't retry"),
    "can't open: don't retry",
  );
});

test("sanitizeMessage：Failed query の SQL の識別子の引用符は残す", () => {
  const out = sanitizeMessage(
    `Failed query: select "id" from "scenes" where "id" = ?\nparams: ${BODY}`,
  );
  assert.equal(out, 'Failed query: select "id" from "scenes" where "id" = ?');
  // 印より前の引用は伏せる。
  assert.ok(
    !sanitizeMessage(`wrap "${BODY}" Failed query: select 1`).includes("Once"),
  );
});

test("sanitizeMessage：ASCII 以外は ?、長い英数字列は <long>、240 字で切る", () => {
  assert.equal(sanitizeMessage("本文あり"), "?");
  const key = "a".repeat(40);
  assert.equal(sanitizeMessage(`key ${key} end`), "key <long> end");
  assert.equal(sanitizeMessage("x ".repeat(300)).length, 240);
});

test("describeError：name、constructor、code、message", () => {
  class FooError extends Error {
    constructor(message, code) {
      super(message);
      this.name = "FooError";
      this.code = code;
    }
  }
  const out = describeError(new FooError("boom", "SNAPSHOT_SOURCE_CHANGED"));
  assert.deepEqual(out, {
    name: "FooError",
    constructorName: "FooError",
    code: "SNAPSHOT_SOURCE_CHANGED",
    message: "boom",
  });
});

test("describeError：code は /^[A-Z0-9_]{3,64}$/ の文字列だけ", () => {
  for (const code of [
    "ab",
    "lower_case",
    "HAS SPACE",
    "A".repeat(65),
    42,
    {},
  ]) {
    const error = Object.assign(new Error("x"), { code });
    assert.equal(describeError(error).code, null, String(code));
  }
  assert.equal(
    describeError(Object.assign(new Error("x"), { code: "ABC" })).code,
    "ABC",
  );
});

test("describeError：Error でない値と、投げる getter でも落ちない", () => {
  assert.deepEqual(describeError(BODY.slice(0, 4)), {
    name: null,
    constructorName: null,
    code: null,
    message: "Once",
  });
  const hostile = {
    get code() {
      throw new Error("no");
    },
    get message() {
      throw new Error("no");
    },
    get name() {
      throw new Error("no");
    },
  };
  const out = describeError(hostile);
  assert.equal(out.code, null);
  assert.equal(out.name, null);
  assert.equal(typeof out.message, "string");
});

test("describeError：message の params 以降は記録しない", () => {
  const out = describeError(new Error(`Failed query: x\nparams: ${BODY}`));
  assert.ok(!JSON.stringify(out).includes("Once upon"));
});

test("describeErrorChain：error＋cause を MAX_CAUSE_DEPTH 段まで", () => {
  let error = new Error("e4");
  for (let i = 3; i >= 0; i--) error = new Error(`e${i}`, { cause: error });
  const { chain, truncated } = describeErrorChain(error);
  assert.equal(MAX_CAUSE_DEPTH, 3);
  assert.deepEqual(
    chain.map((c) => [c.depth, c.message]),
    [
      [0, "e0"],
      [1, "e1"],
      [2, "e2"],
      [3, "e3"],
    ],
  );
  assert.equal(truncated, true);
});

test("describeErrorChain：cause が浅ければ truncated でない。cause の本文は伏せる", () => {
  const error = new Error("outer", {
    cause: new Error(`inner\nparams: ${BODY}`),
  });
  const { chain, truncated } = describeErrorChain(error);
  assert.equal(chain.length, 2);
  assert.equal(truncated, false);
  assert.ok(!JSON.stringify(chain).includes("Once upon"));
});

test("describeErrorChain：循環でも止まる", () => {
  const a = new Error("a");
  const b = new Error("b", { cause: a });
  a.cause = b;
  const { chain, truncated } = describeErrorChain(a);
  assert.equal(chain.length, 2);
  // 循環は深さの上限ではないので truncated にしない。
  assert.equal(truncated, false);
});

// 偽の時計：実時間・CPU 負荷に依存しない。timer は driver が早い順に進める。
function makeClock() {
  let t = 0;
  const timers = [];
  const clock = {
    now: () => t,
    sleep: (ms) =>
      new Promise((resolve) => {
        timers.push({ at: t + ms, resolve });
      }),
    async run(promise) {
      let done = false;
      promise.then(
        () => (done = true),
        () => (done = true),
      );
      for (let i = 0; i < 100_000 && !done; i++) {
        await new Promise((resolve) => setImmediate(resolve));
        if (done) break;
        if (timers.length === 0) throw new Error("stalled: no timers");
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift();
        t = Math.max(t, next.at);
        next.resolve();
      }
      assert.ok(done, "driver iteration cap");
      return promise;
    },
  };
  return clock;
}

const fast = { pollMs: 5, fastMs: 50, timeoutMs: 400 };

function wait(clock, input) {
  return clock.run(
    waitUntilConnectionReady({ now: clock.now, sleep: clock.sleep, ...input }),
  );
}

test("waitUntilConnectionReady：速い probe が 2 回続けば Ready", async () => {
  const clock = makeClock();
  const out = await wait(clock, { ...fast, probe: async () => undefined });
  assert.equal(out.ready, true);
  assert.equal(out.timedOut, false);
  assert.equal(out.polls, 2);
  assert.equal(out.lastState.phase, "idle");
});

test("waitUntilConnectionReady：占有中は待ち、空いたら Ready", async () => {
  const clock = makeClock();
  let calls = 0;
  const out = await wait(clock, {
    ...fast,
    probe: async () => {
      calls++;
      if (calls === 1) await clock.sleep(120);
    },
  });
  assert.equal(out.ready, true);
  // 1 回目は遅い（slow）ので連続の数え直し：遅い 1＋速い 2。
  assert.equal(out.polls, 3);
  assert.ok(out.waitedMs >= 120);
});

test("waitUntilConnectionReady：probe の失敗は連続を切り、code を記録する", async () => {
  const clock = makeClock();
  let calls = 0;
  const out = await wait(clock, {
    ...fast,
    describeFailure: (error) => (error instanceof Error ? "NEX_X" : "other"),
    probe: async () => {
      calls++;
      if (calls === 1) throw new Error("timeout");
    },
  });
  assert.equal(out.ready, true);
  assert.equal(out.polls, 3);
});

test("waitUntilConnectionReady：上限に達したら Ready でなく最後の状態を返す", async () => {
  const clock = makeClock();
  const out = await wait(clock, {
    pollMs: 5,
    fastMs: 50,
    timeoutMs: 60,
    probe: () => new Promise(() => undefined),
  });
  assert.equal(out.ready, false);
  assert.equal(out.timedOut, true);
  assert.equal(out.polls, 1);
  assert.equal(out.lastState.phase, "busy");
  assert.ok(out.waitedMs >= 60);
});

test("waitUntilConnectionReady：失敗し続けても上限で止まり、failure を残す", async () => {
  const clock = makeClock();
  const out = await wait(clock, {
    pollMs: 5,
    fastMs: 50,
    timeoutMs: 60,
    describeFailure: () => "NEX_FAIL",
    probe: async () => {
      throw new Error("x");
    },
  });
  assert.equal(out.ready, false);
  assert.equal(out.lastState.phase, "probe-failed");
  assert.equal(out.lastState.failure, "NEX_FAIL");
});
