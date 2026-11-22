import { afterEach, describe, expect, it, vi } from "vitest";

import type { NapiBackendLike } from "../../shared/ipcContract.js";
import type { MainIssuedCallerIdentity } from "../profileEgress.js";
import {
  createMainReadDb,
  parseNativeReadResult,
  rowToPositional,
} from "./db.js";
import { MainReadError } from "./errors.js";

const IDENTITY: MainIssuedCallerIdentity = {
  profileId: "profile-1",
  callerId: "caller-1",
  callerEpoch: 3,
  senderId: 7,
  workspaceId: "/ws/one",
  sessionId: "session-1",
};

const read = (rows: unknown[]) =>
  JSON.stringify({ rows, __grimodexDbResultKind: "read" });

function fixture(answer: string | (() => Promise<string>) = read([])) {
  const dbExecute = vi.fn(
    typeof answer === "function" ? answer : async () => answer,
  );
  const client = createMainReadDb({
    backend: { dbExecute } as unknown as Pick<NapiBackendLike, "dbExecute">,
    identity: IDENTITY,
  });
  return { dbExecute, client };
}

afterEach(() => vi.useRealTimers());

describe("the statement and the method are checked before anything is sent", () => {
  it.each([
    ["get", "select 1", "method"],
    ["run", "select 1", "method"],
    ["", "select 1", "method"],
    ["all", "delete from tree_nodes", "not-select"],
    ["all", "with t as (select 1) delete from tree_nodes", "not-select"],
    ["all", "select 1; delete from tree_nodes", "multi-statement"],
    ["all", "select * from narrative_runs", "table-not-allowed"],
    ["values", "pragma user_version", "not-select"],
  ])(
    "%s / %s is refused as %s and dbExecute is not called",
    async (method, sql, code) => {
      const { dbExecute, client } = fixture();
      await expect(client(sql, [], method)).rejects.toMatchObject({
        name: "MainReadError",
        code,
        beforeSend: true,
      });
      expect(dbExecute).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, "x", { 0: 1 }, 1])(
    "params %j is not an array: not sent",
    async (params) => {
      const { dbExecute, client } = fixture();
      await expect(
        client("select 1", params as unknown as unknown[], "all"),
      ).rejects.toMatchObject({ code: "params" });
      expect(dbExecute).not.toHaveBeenCalled();
    },
  );

  it("a statement with a lower-case select and a comment is sent", async () => {
    const { dbExecute, client } = fixture();
    await client(
      '/* c */ select "id" from "tree_nodes" where "id" = ?',
      ["a"],
      "all",
    );
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });
});

describe("the statement of the real-addon spec's repeated-column join", () => {
  it("passes the check (a self join of an allowlisted table, with <> in on)", async () => {
    const { dbExecute, client } = fixture();
    await client(
      'select "n"."id", "p"."id" from "tree_nodes" as "n" join "tree_nodes" as "p" on "p"."id" <> "n"."id" limit 1',
      [],
      "all",
    );
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });

  it("refuses a table that no core read names (the allowlist is the core's tables, not every table)", async () => {
    const { dbExecute, client } = fixture();
    await expect(
      client('select "id" from "codex_entries" limit 1', [], "all"),
    ).rejects.toMatchObject({ code: "table-not-allowed", beforeSend: true });
    expect(dbExecute).not.toHaveBeenCalled();
  });
});

describe("what is sent", () => {
  it("is exactly four arguments: the statement, the params, the method and the identity JSON (no own_data_read)", async () => {
    const { dbExecute, client } = fixture();
    await client("select 1 from tree_nodes", ["x"], "values");
    const args = dbExecute.mock.calls[0] as unknown[];
    expect(args).toEqual([
      "select 1 from tree_nodes",
      ["x"],
      "values",
      JSON.stringify(IDENTITY),
    ]);
    expect(args).toHaveLength(4);
  });

  it("never takes the identity from anything but the one the adapter was made with", async () => {
    const a = fixture();
    await a.client("select 1", [], "all");
    expect(JSON.parse((a.dbExecute.mock.calls[0] as string[])[3]!)).toEqual(
      IDENTITY,
    );
  });

  it("an adapter without an identity cannot be made", () => {
    for (const identity of [undefined, null, "x", []]) {
      expect(() =>
        createMainReadDb({
          backend: { dbExecute: vi.fn() },
          identity: identity as unknown as MainIssuedCallerIdentity,
        }),
      ).toThrow(MainReadError);
    }
  });
});

describe("the answer", () => {
  it("is turned from objects into Drizzle's positional arrays, in column order", async () => {
    const { client } = fixture(
      read([
        { id: "a", title: "A", version: 0 },
        { id: "b", title: "B", version: 1 },
      ]),
    );
    await expect(
      client("select 1 from tree_nodes", [], "all"),
    ).resolves.toEqual({
      rows: [
        ["a", "A", 0],
        ["b", "B", 1],
      ],
    });
  });

  it("keeps all the columns of a repeated name (Native suffixes the later ones)", () => {
    // `select "id", "id", "id"`: Native answers id, id\u00001, id\u00002.
    const wire = read([{ id: "x", "id\u00001": "x", "id\u00002": "x" }]);
    expect(parseNativeReadResult(wire)).toEqual([["x", "x", "x"]]);
    // A different value per repeated column keeps its position.
    expect(
      parseNativeReadResult(
        read([{ id: 1, "id\u00001": 2, "id\u00002": 3, name: 4 }]),
      ),
    ).toEqual([[1, 2, 3, 4]]);
  });

  it("an empty result is an empty array of rows", () => {
    expect(parseNativeReadResult(read([]))).toEqual([]);
  });

  it("refuses a column with an integer-like name: Object.values would reorder it", () => {
    // JSON.parse keeps text order, but Object.values lists "0" and "1" first.
    const wire =
      '{"rows":[{"a":"x","1":1,"0":2}],"__grimodexDbResultKind":"read"}';
    expect(Object.values(JSON.parse(wire).rows[0])).toEqual([2, 1, "x"]);
    expect(() => parseNativeReadResult(wire)).toThrow(MainReadError);
    expect(() => rowToPositional({ "1": 1 })).toThrow(/integer-like/);
    // A name that merely contains digits is fine.
    expect(rowToPositional({ a1: 1, "01": 2, "1a": 3 })).toEqual([1, 2, 3]);
  });

  it.each([
    [
      "a committed mutation",
      '{"rows":[],"__grimodexDbResultKind":"committed-mutation"}',
      "result-marker",
    ],
    [
      "an invalid marker",
      '{"rows":[],"__grimodexDbResultKind":"invalid"}',
      "result-marker",
    ],
    [
      "no marker (a committed receipt)",
      '{"rows":[],"committed":true}',
      "result-marker",
    ],
    [
      "a marker that is not text",
      '{"rows":[],"__grimodexDbResultKind":1}',
      "result-marker",
    ],
    [
      "a marker with another case",
      '{"rows":[],"__grimodexDbResultKind":"Read"}',
      "result-marker",
    ],
    [
      "an extra key",
      '{"rows":[],"__grimodexDbResultKind":"read","extra":1}',
      "result-key",
    ],
    [
      "rows that is not an array",
      '{"rows":{},"__grimodexDbResultKind":"read"}',
      "result-shape",
    ],
    ["no rows", '{"__grimodexDbResultKind":"read"}', "result-key"],
    [
      "a row that is an array",
      '{"rows":[[1]],"__grimodexDbResultKind":"read"}',
      "result-shape",
    ],
    [
      "a row that is null",
      '{"rows":[null],"__grimodexDbResultKind":"read"}',
      "result-shape",
    ],
    [
      "a row that is a number",
      '{"rows":[1],"__grimodexDbResultKind":"read"}',
      "result-shape",
    ],
    ["an answer that is an array", "[]", "result-shape"],
    ["an answer that is null", "null", "result-shape"],
    ["an answer that is not JSON", "{", "result-shape"],
    ["an empty answer", "", "result-shape"],
  ])("throws on %s", (_name, wire, code) => {
    expect(() => parseNativeReadResult(wire)).toThrow(
      expect.objectContaining({ name: "MainReadError", code }),
    );
  });

  it("throws on an answer that is not text, instead of passing it on", () => {
    for (const value of [undefined, null, 1, {}, { rows: [] }]) {
      expect(() => parseNativeReadResult(value)).toThrow(MainReadError);
    }
  });

  it("throws through the adapter on a committed answer, after it was sent", async () => {
    const { dbExecute, client } = fixture(
      '{"rows":[],"__grimodexDbResultKind":"committed-mutation"}',
    );
    await expect(client("select 1", [], "all")).rejects.toMatchObject({
      code: "result-marker",
      beforeSend: false,
    });
    expect(dbExecute).toHaveBeenCalledTimes(1);
  });

  it("does not return the marker to the caller", async () => {
    const { client } = fixture(read([{ a: 1 }]));
    const result = await client("select 1", [], "all");
    expect(Object.keys(result)).toEqual(["rows"]);
    expect(JSON.stringify(result)).not.toContain("__grimodexDbResultKind");
  });

  it("lets Native's own refusal through as it is", async () => {
    const { client } = fixture(async () => {
      throw new Error("D2A_EGRESS_DENIED: caller identity is malformed");
    });
    await expect(client("select 1", [], "all")).rejects.toThrow(
      /D2A_EGRESS_DENIED/,
    );
  });
});

describe("the caller timeout and the lifecycle hooks", () => {
  it("cuts a read that does not answer at 10 s, and keeps the in-flight promise until Native settles", async () => {
    vi.useFakeTimers();
    let release!: (wire: string) => void;
    const native = new Promise<string>((resolve) => {
      release = resolve;
    });
    const tracked: Promise<void>[] = [];
    const dbExecute = vi.fn(() => native);
    const client = createMainReadDb({
      backend: { dbExecute } as unknown as Pick<NapiBackendLike, "dbExecute">,
      identity: IDENTITY,
      trackInFlight: (settled) => tracked.push(settled),
    });
    const outcome = client("select 1", [], "all").then(
      () => "answered",
      (error: MainReadError) => error.code,
    );
    await vi.advanceTimersByTimeAsync(9_999);
    let settledFlag = false;
    void tracked[0]!.then(() => {
      settledFlag = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe("timeout");
    // Native has not settled: the count the owner keeps must still be up.
    await vi.advanceTimersByTimeAsync(0);
    expect(settledFlag).toBe(false);
    release(read([]));
    await tracked[0];
    expect(settledFlag).toBe(true);
  });

  it("drops the late rejection of a read that timed out (no unhandled rejection)", async () => {
    vi.useFakeTimers();
    let fail!: (error: Error) => void;
    const native = new Promise<string>((_resolve, reject) => {
      fail = reject;
    });
    const client = createMainReadDb({
      backend: { dbExecute: () => native } as unknown as Pick<
        NapiBackendLike,
        "dbExecute"
      >,
      identity: IDENTITY,
    });
    const outcome = client("select 1", [], "all").catch(
      (e: MainReadError) => e.code,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toBe("timeout");
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    fail(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("does not time out a read that answers in time, and clears its timer", async () => {
    vi.useFakeTimers();
    const { client } = fixture(read([{ a: 1 }]));
    await expect(client("select 1", [], "all")).resolves.toEqual({
      rows: [[1]],
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("asserts the turn is live before sending (no send when it throws) and after (the result is dropped)", async () => {
    const order: string[] = [];
    const dbExecute = vi.fn(async () => {
      order.push("native");
      return read([{ a: 1 }]);
    });
    const backend = { dbExecute } as unknown as Pick<
      NapiBackendLike,
      "dbExecute"
    >;
    let live = true;
    const client = createMainReadDb({
      backend,
      identity: IDENTITY,
      assertLive: () => {
        order.push("live");
        if (!live) throw new Error("turn is closed");
      },
    });
    await client("select 1", [], "all");
    expect(order).toEqual(["live", "native", "live"]);

    live = false;
    order.length = 0;
    await expect(client("select 1", [], "all")).rejects.toThrow(
      /turn is closed/,
    );
    expect(order).toEqual(["live"]);
    expect(dbExecute).toHaveBeenCalledTimes(1);

    // Closed while Native was answering: the answer is discarded.
    live = true;
    const closing = createMainReadDb({
      backend: {
        dbExecute: async () => {
          live = false;
          return read([{ a: 1 }]);
        },
      } as unknown as Pick<NapiBackendLike, "dbExecute">,
      identity: IDENTITY,
      assertLive: () => {
        if (!live) throw new Error("turn is closed");
      },
    });
    await expect(closing("select 1", [], "all")).rejects.toThrow(/closed/);
  });
});
