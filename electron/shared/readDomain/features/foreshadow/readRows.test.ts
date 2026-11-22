import { describe, expect, it } from "vitest";

import { toBool, toDate, toNullableDate } from "./coerce.js";
import {
  buildForeshadowsWithLabels,
  buildOpenForeshadowsForContext,
  normalizeSetupLabelInput,
  normalizeSetupRow,
  openForeshadowsFromWire,
  type SetupLabelInput,
} from "./readRows.js";
import type { ForeshadowRow } from "./types.js";

const T = 1_767_225_600_000;

const nativeForeshadow = (over: Record<string, unknown> = {}) => ({
  id: "f1",
  title: "杖",
  intent: "意図",
  load_bearing: "critical",
  version: 3,
  payoff_confirmed: 0,
  abandoned: 0,
  updated_at: T,
  ...over,
});
const nativeSetup = (over: Record<string, unknown> = {}) => ({
  foreshadow_id: "f1",
  is_orphan: 0,
  strength: null,
  ai_strength: null,
  ai_reasoning: null,
  ...over,
});

describe("coercions", () => {
  it("toDate reads a Date, epoch milliseconds and an ISO string; anything else is the epoch", () => {
    const date = new Date(T);
    expect(toDate(date)).toBe(date);
    expect(toDate(T).getTime()).toBe(T);
    expect(toDate("2026-01-01T00:00:00.000Z").getTime()).toBe(T);
    expect(toDate(undefined).getTime()).toBe(0);
    expect(toDate(null).getTime()).toBe(0);
    expect(toDate({}).getTime()).toBe(0);
  });

  it("toNullableDate keeps null and undefined as null", () => {
    expect(toNullableDate(null)).toBeNull();
    expect(toNullableDate(undefined)).toBeNull();
    expect(toNullableDate(T)?.getTime()).toBe(T);
  });

  it("toBool reads a boolean and the integer 0/1 only", () => {
    expect(toBool(true)).toBe(true);
    expect(toBool(false)).toBe(false);
    expect(toBool(1)).toBe(true);
    expect(toBool(0)).toBe(false);
    expect(toBool(2)).toBe(false);
    expect(toBool("1")).toBe(false);
    expect(toBool(undefined)).toBe(false);
  });
});

describe("normalizeSetupRow", () => {
  it("reads snake_case (Native) and camelCase (Drizzle) to the same row", () => {
    const snake = normalizeSetupRow({
      id: "s1",
      foreshadow_id: "f1",
      scene_id: "n1",
      from_pos: 2,
      to_pos: 9,
      kind: "rewritten",
      strength: "overt",
      ai_strength: "subtle",
      ai_reasoning: "r",
      attribution: "ai",
      ai_rationale: "why",
      last_evaluated_at: T,
      is_orphan: 1,
      created_at: T,
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const camel = normalizeSetupRow({
      id: "s1",
      foreshadowId: "f1",
      sceneId: "n1",
      fromPos: 2,
      toPos: 9,
      kind: "rewritten",
      strength: "overt",
      aiStrength: "subtle",
      aiReasoning: "r",
      attribution: "ai",
      aiRationale: "why",
      lastEvaluatedAt: new Date(T),
      isOrphan: true,
      createdAt: new Date(T),
      updatedAt: new Date(T),
    });
    expect(snake).toEqual(camel);
    expect(snake.isOrphan).toBe(true);
    expect(snake.lastEvaluatedAt?.getTime()).toBe(T);
  });

  it("fills the defaults of a row with only the label columns (a Native setup has no scene_id)", () => {
    const row = normalizeSetupRow(nativeSetup({ ai_strength: "subtle" }));
    expect(row.sceneId).toBe("");
    expect(row.kind).toBe("designated_existing");
    expect(row.attribution).toBe("human");
    expect(row.lastEvaluatedAt).toBeNull();
    expect(row.aiStrength).toBe("subtle");
    expect(row.isOrphan).toBe(false);
    expect(normalizeSetupRow(null).foreshadowId).toBe("");
  });

  it("normalizeSetupLabelInput keeps exactly the six label fields", () => {
    expect(Object.keys(normalizeSetupLabelInput(nativeSetup())).sort()).toEqual(
      [
        "aiReasoning",
        "aiStrength",
        "foreshadowId",
        "isOrphan",
        "sceneId",
        "strength",
      ].sort(),
    );
  });
});

describe("buildOpenForeshadowsForContext", () => {
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `T-${id}`,
    intent: null,
    loadBearing: null,
    version: 0,
    payoffConfirmed: false,
    abandoned: false,
    updatedAt: T,
    ...over,
  });
  const setup = (foreshadowId: string, over: Partial<SetupLabelInput> = {}) =>
    ({
      foreshadowId,
      isOrphan: false,
      strength: null,
      aiStrength: null,
      aiReasoning: null,
      ...over,
    }) as SetupLabelInput;
  const ids = (xs: Array<{ id: string }>) => xs.map((x) => x.id);

  it("is empty for no rows, whatever the setups", () => {
    expect(buildOpenForeshadowsForContext([], [setup("f1")])).toEqual([]);
  });

  it("orders critical > supporting > optional > none, then newest first", () => {
    const out = buildOpenForeshadowsForContext(
      [
        row("none-new", { updatedAt: T + 5 }),
        row("opt", { loadBearing: "optional" }),
        row("crit-old", { loadBearing: "critical", updatedAt: T }),
        row("sup", { loadBearing: "supporting" }),
        row("crit-new", { loadBearing: "critical", updatedAt: T + 1 }),
      ],
      [],
    );
    expect(ids(out)).toEqual([
      "crit-new",
      "crit-old",
      "sup",
      "opt",
      "none-new",
    ]);
  });

  it("keeps the input order for the same priority and the same time", () => {
    const out = buildOpenForeshadowsForContext(
      [row("b"), row("a"), row("c")],
      [],
    );
    expect(ids(out)).toEqual(["b", "a", "c"]);
  });

  it("puts a row with no updatedAt after the ones that have one (same priority)", () => {
    const out = buildOpenForeshadowsForContext(
      [
        row("missing", { updatedAt: undefined }),
        row("dated", { updatedAt: T }),
      ],
      [],
    );
    expect(ids(out)).toEqual(["dated", "missing"]);
  });

  it("reads updatedAt as a Date, epoch milliseconds or an ISO string", () => {
    const out = buildOpenForeshadowsForContext(
      [
        row("date", { updatedAt: new Date(T + 1) }),
        row("iso", { updatedAt: "2026-01-01T00:00:00.000Z" }),
        row("ms", { updatedAt: T + 2 }),
      ],
      [],
    );
    expect(ids(out)).toEqual(["ms", "date", "iso"]);
  });

  it("counts the setups of a foreshadow without its orphans", () => {
    const out = buildOpenForeshadowsForContext(
      [row("f1"), row("f2")],
      [
        setup("f1"),
        setup("f1", { isOrphan: true }),
        setup("f1"),
        setup("f2", { isOrphan: true }),
        // a setup of a foreshadow that is not in the list is not counted anywhere
        setup("other"),
      ],
    );
    expect(Object.fromEntries(out.map((o) => [o.id, o.setupCount]))).toEqual({
      f1: 2,
      f2: 0,
    });
  });

  it("carries the derived label and leaves out the internal sort key", () => {
    const [only] = buildOpenForeshadowsForContext([row("f1")], [setup("f1")]);
    expect(Object.keys(only!).sort()).toEqual(
      [
        "derivedLabel",
        "id",
        "intent",
        "loadBearing",
        "setupCount",
        "title",
        "version",
      ].sort(),
    );
    expect(only!.derivedLabel).toBe("seeded");
  });
});

describe("buildForeshadowsWithLabels", () => {
  const base = (id: string, over: Partial<ForeshadowRow> = {}): ForeshadowRow =>
    ({
      id,
      projectId: "p",
      title: id,
      intent: null,
      notes: null,
      payoffSceneId: null,
      payoffFromPos: null,
      payoffToPos: null,
      payoffConfirmed: false,
      abandoned: false,
      secret: false,
      loadBearing: null,
      version: 0,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      ...over,
    }) as ForeshadowRow;

  it("labels by setup count and weakness, and an orphan counts for nothing", () => {
    const out = buildForeshadowsWithLabels(
      [base("a"), base("b", { loadBearing: "critical" })],
      [
        {
          foreshadowId: "b",
          isOrphan: false,
          strength: "subtle",
          aiStrength: null,
          aiReasoning: null,
        },
        {
          foreshadowId: "a",
          isOrphan: true,
          strength: "subtle",
          aiStrength: null,
          aiReasoning: null,
        },
      ],
    );
    expect(out.map((o) => [o.id, o.setupCount, o.label])).toEqual([
      ["a", 0, "planned"],
      ["b", 1, "critical_weak"],
    ]);
    expect(buildForeshadowsWithLabels([], [])).toEqual([]);
  });
});

describe("openForeshadowsFromWire", () => {
  it("builds the list from Native's own wire (snake_case, 0/1, epoch ms, no scene_id in a setup)", () => {
    const out = openForeshadowsFromWire({
      foreshadows: [
        nativeForeshadow(),
        nativeForeshadow({
          id: "f2",
          title: "軽い",
          intent: null,
          load_bearing: null,
        }),
      ],
      setups: [
        nativeSetup({ ai_strength: "subtle" }),
        nativeSetup({ strength: "overt" }),
        nativeSetup({ is_orphan: 1, strength: "moderate" }),
      ],
    });
    expect(
      out.map((o) => [o.id, o.loadBearing, o.setupCount, o.intent]),
    ).toEqual([
      ["f1", "critical", 2, "意図"],
      ["f2", null, 0, null],
    ]);
  });

  it("builds the same list from the in-browser branch's rows (camelCase, booleans, Dates, scene ids)", () => {
    const native = openForeshadowsFromWire({
      foreshadows: [nativeForeshadow()],
      setups: [nativeSetup({ ai_strength: "subtle" })],
    });
    const browser = openForeshadowsFromWire({
      foreshadows: [
        {
          id: "f1",
          title: "杖",
          intent: "意図",
          loadBearing: "critical",
          version: 3,
          payoffConfirmed: false,
          abandoned: false,
          updatedAt: new Date(T),
        },
      ],
      setups: [
        {
          foreshadowId: "f1",
          sceneId: "n1",
          isOrphan: false,
          strength: null,
          aiStrength: "subtle",
          aiReasoning: null,
        },
      ],
    });
    expect(browser).toEqual(native);
  });

  it("accepts empty lists (an empty project)", () => {
    expect(openForeshadowsFromWire({ foreshadows: [], setups: [] })).toEqual(
      [],
    );
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "{}"],
    ["an array", []],
    ["a number", 1],
  ])("throws when the wire is %s (it is not an object)", (_label, wire) => {
    expect(() => openForeshadowsFromWire(wire)).toThrow(/not an object/);
  });

  it("throws when foreshadows or setups is missing or not an array (never reads it as empty)", () => {
    expect(() => openForeshadowsFromWire({ setups: [] })).toThrow(
      /foreshadows is not an array/,
    );
    expect(() => openForeshadowsFromWire({ foreshadows: [] })).toThrow(
      /setups is not an array/,
    );
    expect(() =>
      openForeshadowsFromWire({ foreshadows: null, setups: [] }),
    ).toThrow(/foreshadows is not an array/);
    expect(() =>
      openForeshadowsFromWire({
        foreshadows: [nativeForeshadow()],
        setups: {},
      }),
    ).toThrow(/setups is not an array/);
    // A renamed key is the same as a missing one: not "0 open foreshadows".
    expect(() =>
      openForeshadowsFromWire({
        foreshadow_rows: [nativeForeshadow()],
        setups: [],
      }),
    ).toThrow(/foreshadows is not an array/);
  });

  it("throws on a foreshadow row that is not an object or has no string id and title (no phantom foreshadow)", () => {
    for (const row of [null, undefined, "f1", 1]) {
      expect(() =>
        openForeshadowsFromWire({ foreshadows: [row], setups: [] }),
      ).toThrow(/foreshadow row is not an object/);
    }
    for (const row of [
      {},
      { id: "f1" },
      { title: "t" },
      { id: 1, title: "t" },
      { id: "f1", title: null },
    ]) {
      expect(() =>
        openForeshadowsFromWire({ foreshadows: [row], setups: [] }),
      ).toThrow(/no string id and title/);
    }
  });

  it("throws on a setup row that is not an object or has no string foreshadow_id (a count of 0 for everyone would be a success the model believes)", () => {
    for (const row of [null, undefined, "x"]) {
      expect(() =>
        openForeshadowsFromWire({
          foreshadows: [nativeForeshadow()],
          setups: [row],
        }),
      ).toThrow(/setup row is not an object/);
    }
    for (const row of [{}, { foreshadow_id: 1 }, { is_orphan: 0 }]) {
      expect(() =>
        openForeshadowsFromWire({
          foreshadows: [nativeForeshadow()],
          setups: [row],
        }),
      ).toThrow(/no string foreshadow_id/);
    }
    // camelCase is the in-browser branch's key.
    expect(
      openForeshadowsFromWire({
        foreshadows: [nativeForeshadow()],
        setups: [{ foreshadowId: "f1", isOrphan: false }],
      })[0]!.setupCount,
    ).toBe(1);
  });

  it("reads a missing updated_at as the epoch: that row sorts last in its priority", () => {
    const out = openForeshadowsFromWire({
      foreshadows: [
        nativeForeshadow({ id: "no-time", updated_at: undefined }),
        nativeForeshadow({ id: "timed" }),
      ],
      setups: [],
    });
    expect(out.map((o) => o.id)).toEqual(["timed", "no-time"]);
  });
});
