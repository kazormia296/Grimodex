import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  MODELS_DEV_PROVIDER_MAP,
  SNAPSHOT_FAILURE_CATEGORY,
  SNAPSHOT_FAILURE_CODES,
  SNAPSHOT_POLICY,
  SNAPSHOT_PROVIDERS,
  canonicalize,
  compareSnapshots,
  normalizeModelsDev,
  parseModelsDevText,
  parseSnapshot,
  sha256Hex,
  type ModelEntry,
  type Snapshot,
  type SnapshotPolicy,
} from "./modelCapabilityRegistry.js";

const P: SnapshotPolicy = SNAPSHOT_POLICY;
const NOW = Date.parse("2026-11-19T12:00:00Z");
const CTX = { nowMs: NOW };
const GENERATED_AT = "2026-11-19T00:00:00Z";
const MARKER = "SECRET_MARKER_8f3a";
const NORMALIZE_CTX = {
  generatedAt: GENERATED_AT,
  source: "models.dev",
} as const;

function snapshotText(
  models: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: GENERATED_AT,
    source: "models.dev",
    models,
    ...overrides,
  });
}

const GOOD_MODELS = {
  "anthropic/claude-sonnet-4-6": {
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    toolCall: true,
    reasoning: true,
  },
  "openai/gpt-4.1": {
    contextWindow: 1_047_576,
    maxOutputTokens: 32_768,
    toolCall: true,
    reasoning: false,
  },
  "openrouter/cohere/command-a": {
    contextWindow: 256_000,
    maxOutputTokens: 8_192,
    toolCall: true,
    reasoning: false,
  },
};

function parseOk(text: string, policy: SnapshotPolicy = P): Snapshot {
  const result = parseSnapshot(text, policy, CTX);
  if (!result.ok) throw new Error(`unexpected failure: ${result.code}`);
  return result.snapshot;
}

function parseCode(text: string, policy: SnapshotPolicy = P): string {
  const result = parseSnapshot(text, policy, CTX);
  return result.ok ? "ok" : result.code;
}

function makeSnapshot(
  models: Record<string, ModelEntry>,
  generatedAt = GENERATED_AT,
): Snapshot {
  return parseOk(snapshotText(models, { generatedAt }));
}

/** models.dev の応答の手書きの抜粋（実応答は repo に入れない）。 */
const MODELS_DEV_EXCERPT = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    doc: "https://example.invalid/doc",
    models: {
      "claude-fable-5-1": {
        id: "claude-fable-5-1",
        name: "Claude Fable 5.1",
        description: "説明は読まない",
        attachment: true,
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        tool_call: true,
        limit: { context: 1_000_000, output: 128_000, input: 900_000 },
      },
    },
  },
  openai: {
    models: {
      "gpt-4.1": {
        reasoning: false,
        tool_call: true,
        limit: { context: 1_047_576, output: 32_768 },
      },
      "text-embedding-3-small": {
        type: "embedding",
        reasoning: false,
        tool_call: false,
        limit: { context: 8_191, output: 1_536 },
      },
      "gpt-unknown-limit": {
        reasoning: true,
        tool_call: true,
        limit: { context: 0, output: 0 },
      },
    },
  },
  openrouter: {
    models: {
      "~anthropic/claude-opus-latest": {
        type: "chat",
        reasoning: true,
        tool_call: true,
        limit: { context: 1_000_000, output: 128_000 },
      },
      "cohere/command-a": {
        reasoning: false,
        tool_call: false,
        limit: { context: 256_000, output: 8_192 },
      },
    },
  },
  sakana: {
    models: {
      fugu: {
        reasoning: true,
        tool_call: true,
        limit: { context: 1_000_000, output: 1_000_000 },
      },
    },
  },
  "ollama-cloud": {
    models: {
      "gpt-oss:20b": {
        reasoning: true,
        tool_call: true,
        limit: { context: 131_072, output: 32_768 },
      },
    },
  },
  "some-gateway": { models: { x: { reasoning: true, tool_call: true } } },
};

describe("policy と対応表", () => {
  it("閾値は暫定の 1 つの定数群で、不変かつ矛盾しない", () => {
    expect(Object.isFrozen(P)).toBe(true);
    expect(P.minContextWindow).toBeLessThan(P.maxContextWindow);
    expect(P.minMaxOutputTokens).toBeLessThan(P.maxMaxOutputTokens);
    expect(P.maxInvalidRatio).toBeGreaterThan(0);
    expect(P.maxInvalidRatio).toBeLessThan(1);
    expect(P.minCountRatio).toBeGreaterThan(0);
    expect(P.minCountRatio).toBeLessThan(1);
    // 直接取得（models.dev）の上限は写しの上限より大きい（T4: 別の上限）。
    expect(P.maxRawBytes).toBeGreaterThan(P.maxSnapshotBytes);
    expect(P.maxRawDepth).toBeGreaterThan(P.maxSnapshotDepth);
  });

  it("対応表の値は写しの provider の閉じた集合に含まれ、表に無い provider は含まれない", () => {
    for (const value of MODELS_DEV_PROVIDER_MAP.values()) {
      expect(SNAPSHOT_PROVIDERS).toContain(value);
    }
    expect(MODELS_DEV_PROVIDER_MAP.has("ollama-cloud")).toBe(false);
    expect(MODELS_DEV_PROVIDER_MAP.has("constructor")).toBe(false);
  });

  it("全ての失敗 code に種別がある", () => {
    for (const code of SNAPSHOT_FAILURE_CODES) {
      expect(SNAPSHOT_FAILURE_CATEGORY[code]).toBeTruthy();
    }
  });
});

describe("module の純粋さ", () => {
  // コメント（説明の文章）を除いた実コードに対して調べる。この module の文字列 literal に
  // `//` は無いので、行コメントの除去で実コードを削らない。
  const source = readFileSync(
    fileURLToPath(new URL("./modelCapabilityRegistry.ts", import.meta.url)),
    "utf8",
  )
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/\/\/.*$/gmu, "");

  it("他の module を import せず、Node／Electron の API に触れない", () => {
    expect(source).not.toMatch(/^\s*import\b/mu);
    expect(source).not.toMatch(/^\s*export\s+.*\bfrom\s+["']/mu);
    expect(source).not.toMatch(/\brequire\s*\(/u);
    expect(source).not.toMatch(/\bimport\s*\(/u);
    expect(source).not.toMatch(/\bprocess\b|\bBuffer\b|\bglobalThis\b/u);
    expect(source).not.toMatch(/Date\.now\s*\(|new Date\(\s*\)|fetch\s*\(/u);
    // 型の除去で消えない構文（Node の型除去で動かなくなる）を使わない。
    expect(source).not.toMatch(/^\s*(?:export\s+)?(?:const\s+)?enum\b/mu);
    expect(source).not.toMatch(
      /^\s*(?:export\s+)?(?:declare\s+)?namespace\b/mu,
    );
  });

  const stripsTypes = Boolean(
    (process.features as { typescript?: unknown }).typescript,
  );
  it.skipIf(!stripsTypes)(
    "install なしの Node script から .ts を直接 import して動く",
    () => {
      const modulePath = fileURLToPath(
        new URL("./modelCapabilityRegistry.ts", import.meta.url),
      );
      const script = `
        import { pathToFileURL } from "node:url";
        const m = await import(pathToFileURL(process.argv[1]).href);
        process.stdout.write(m.sha256Hex("abc"));
      `;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script, modulePath],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      );
    },
  );
});

describe("sha256Hex", () => {
  it("node:crypto の SHA-256 と一致する（padding の境界を含む）", () => {
    const inputs = [
      "",
      "abc",
      "あいう🙂",
      ...[1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 128, 1000, 100_000].map(
        (n) => "x".repeat(n),
      ),
    ];
    for (const input of inputs) {
      expect(sha256Hex(input)).toBe(
        createHash("sha256").update(input, "utf8").digest("hex"),
      );
    }
  });
});

describe("canonicalize", () => {
  it("key の挿入順に依らず同じ文字列になり、厳密な形式を保つ", () => {
    const a = makeSnapshot({
      "openai/gpt-4.1": { toolCall: false, contextWindow: 8192 },
      "anthropic/claude-sonnet-4-6": { reasoning: true },
    });
    const b = makeSnapshot({
      "anthropic/claude-sonnet-4-6": { reasoning: true },
      "openai/gpt-4.1": { contextWindow: 8192, toolCall: false },
    });
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe(
      '{"generatedAt":"2026-11-19T00:00:00Z","models":{' +
        '"anthropic/claude-sonnet-4-6":{"reasoning":true},' +
        '"openai/gpt-4.1":{"contextWindow":8192,"toolCall":false}},' +
        '"schemaVersion":1,"source":"models.dev"}',
    );
  });

  it("parse → canonicalize が不動点になり、digest は canonical 文字列の SHA-256", () => {
    const first = parseSnapshot(snapshotText(GOOD_MODELS), P, CTX);
    if (!first.ok) throw new Error("parse failed");
    const canonical = canonicalize(first.snapshot);
    expect(first.digest).toBe(
      createHash("sha256").update(canonical).digest("hex"),
    );
    const second = parseSnapshot(canonical, P, CTX);
    if (!second.ok) throw new Error("parse failed");
    expect(canonicalize(second.snapshot)).toBe(canonical);
    expect(second.digest).toBe(first.digest);
  });

  it("整数でない値を持つ（未検証の）写しは例外にする", () => {
    const bad = {
      schemaVersion: 1,
      generatedAt: GENERATED_AT,
      source: "models.dev",
      models: { "openai/x": { contextWindow: Number.NaN } },
    } as unknown as Snapshot;
    expect(() => canonicalize(bad)).toThrow(TypeError);
  });
});

describe("parseSnapshot：正常系", () => {
  it("検証を通った写しを返し、prototype を持たず、変更できない", () => {
    const snapshot = parseOk(snapshotText(GOOD_MODELS));
    expect(Object.getPrototypeOf(snapshot.models)).toBeNull();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.models)).toBe(true);
    expect(snapshot.models["openai/gpt-4.1"]).toEqual({
      contextWindow: 1_047_576,
      maxOutputTokens: 32_768,
      toolCall: true,
      reasoning: false,
    });
    expect(snapshot.source).toBe("models.dev");
  });

  it("field が無いことは undefined のままで、false は明示された値だけ", () => {
    const snapshot = parseOk(
      snapshotText({
        "openai/a": { contextWindow: 8192 },
        "openai/b": { toolCall: false },
      }),
    );
    const a = snapshot.models["openai/a"] as ModelEntry;
    const b = snapshot.models["openai/b"] as ModelEntry;
    expect(a.toolCall).toBeUndefined();
    expect("toolCall" in a).toBe(false);
    expect(a.reasoning).toBeUndefined();
    expect(b.toolCall).toBe(false);
    expect(b.reasoning).toBeUndefined();
  });

  it("id に / と : と先頭の ~ を持つ key を通す", () => {
    const snapshot = parseOk(
      snapshotText({
        "openrouter/~anthropic/claude-opus-latest": { reasoning: true },
        "openrouter/qwen/qwen3:free": { toolCall: true },
      }),
    );
    expect(Object.keys(snapshot.models)).toHaveLength(2);
  });

  it("generatedAt が許容差の内の未来なら通し、古い日時も単独では通す", () => {
    expect(
      parseCode(
        snapshotText(GOOD_MODELS, { generatedAt: "2026-11-20T11:59:00Z" }),
      ),
    ).toBe("ok");
    expect(
      parseCode(
        snapshotText(GOOD_MODELS, { generatedAt: "2020-01-01T00:00:00Z" }),
      ),
    ).toBe("ok");
  });

  it("形が正しく provider が閉じた集合に無い key は、不正でなく「無視」として数える", () => {
    const models: Record<string, unknown> = { ...GOOD_MODELS };
    // 将来の版が足す provider。割合の分母に入らず、写し全体を捨てる理由にならない。
    for (let i = 0; i < 50; i += 1) {
      models[`future-provider/m${i}`] = { contextWindow: 8192 };
    }
    models["ollama/x"] = "未検証の値は読まない";
    const result = parseSnapshot(snapshotText(models), P, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.snapshot.models)).toHaveLength(3);
    expect(result.snapshot.models["ollama/x"]).toBeUndefined();
    expect(result.findings).toEqual([
      { code: "ignored-provider-model", count: 51 },
    ]);
  });

  it("provider の形が違う key（大文字・記号）は不正のままで、割合に数える", () => {
    const models: Record<string, unknown> = {};
    for (let i = 0; i < 90; i += 1)
      models[`openai/ok${i}`] = { toolCall: true };
    for (let i = 0; i < 10; i += 1) {
      models[`Bad_Provider/m${i}`] = { contextWindow: 8192 };
    }
    expect(parseCode(snapshotText(models))).toBe("too-many-invalid");
  });

  it("対応外の provider の key だけの写しは empty", () => {
    expect(
      parseCode(snapshotText({ "future-provider/a": { contextWindow: 8192 } })),
    ).toBe("empty");
  });

  it("未知の field は捨てて件数を findings に残す", () => {
    const result = parseSnapshot(
      snapshotText({
        "openai/a": { contextWindow: 8192, url: MARKER, note: { x: 1 } },
      }),
      P,
      CTX,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.models["openai/a"]).toEqual({ contextWindow: 8192 });
    expect(result.findings).toEqual([
      { code: "unknown-field-dropped", count: 2 },
    ]);
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });
});

describe("parseSnapshot：本文の形", () => {
  it.each([
    ["空文字列", ""],
    ["空白だけ", "   \n"],
    ["途中で切れた JSON", snapshotText(GOOD_MODELS).slice(0, 60)],
    ["JSON でない", "not json"],
    ["末尾の余分な文字", `${snapshotText(GOOD_MODELS)}x`],
    ["閉じていない括弧", '{"a":{"b":1}'],
    ["閉じすぎた括弧", '{"a":1}}'],
    ["閉じていない文字列", '{"a":"b'],
  ])("%s は syntax", (_name, text) => {
    expect(parseCode(text)).toBe("syntax");
  });

  it.each([
    ["配列", "[]"],
    ["数値", "1"],
    ["null", "null"],
    ["文字列", '"x"'],
    ["空の object", "{}"],
  ])("root が %s なら schema", (_name, text) => {
    expect(parseCode(text)).toBe("schema");
  });

  it("文字列の中の括弧や引用符は深さ・key として数えない", () => {
    const text = snapshotText(
      { "openai/a": { contextWindow: 8192 } },
      { note: undefined },
    );
    expect(parseCode(text)).toBe("ok");
    // value に括弧・escape された引用符があっても、他の検証は変わらない。
    const tricky =
      '{"schemaVersion":1,"generatedAt":"2026-11-19T00:00:00Z","source":"models.dev",' +
      '"models":{"openai/a":{"contextWindow":8192,"x":"{[\\"{[[[[[[["}}}';
    expect(parseCode(tricky)).toBe("ok");
  });

  it("backslash で終わる文字列は、直後の引用符を文字列の終わりとして扱う", () => {
    const head =
      '{"schemaVersion":1,"generatedAt":"2026-11-19T00:00:00Z","source":"models.dev",';
    expect(
      parseCode(
        `${head}"models":{"openai/a":{"contextWindow":8192,"x":"end\\\\"}}}`,
      ),
    ).toBe("ok");
    // key が backslash で終わる object の重複も検出する。
    expect(
      parseCode(
        `${head}"models":{"openai/a":{"contextWindow":8192,"k\\\\":1,"k\\\\":2}}}`,
      ),
    ).toBe("duplicate-key");
  });

  it("整形された（改行・インデント・CRLF の）JSON も通す", () => {
    const text = JSON.stringify(
      JSON.parse(snapshotText(GOOD_MODELS)) as unknown,
      null,
      2,
    );
    expect(parseCode(text)).toBe("ok");
    expect(parseCode(text.replace(/\n/gu, "\r\n"))).toBe("ok");
  });

  it("巨大な入力は parse の前に too-large", () => {
    const small = { ...P, maxSnapshotBytes: 100 };
    expect(parseCode(snapshotText(GOOD_MODELS), small)).toBe("too-large");
    // UTF-16 の長さは小さくても UTF-8 の byte 数で数える。
    const wide = { ...P, maxSnapshotBytes: 1000 };
    const text = snapshotText({ "openai/a": { contextWindow: 8192 } });
    expect(parseCode(text, wide)).toBe("ok");
    expect(parseCode(`${text}${" ".repeat(950)}`, wide)).toBe("too-large");
    const multibyte = `${text}${"あ".repeat(300)}`; // 長さは 1000 未満、byte 数は超える
    expect(multibyte.length).toBeLessThan(1000);
    expect(parseCode(multibyte, wide)).toBe("too-large");
  });

  it("深い入力は too-deep（stack を使い切らずに止まる）", () => {
    const deep = `${"[".repeat(100_000)}${"]".repeat(100_000)}`;
    expect(parseCode(deep)).toBe("too-deep");
    const nested = snapshotText({
      "openai/a": { contextWindow: 8192, x: { y: { z: 1 } } },
    });
    expect(parseCode(nested)).toBe("too-deep");
    expect(parseCode(nested, { ...P, maxSnapshotDepth: 6 })).toBe("ok");
  });

  it.each([
    ["root の重複", '{"schemaVersion":1,"schemaVersion":1}'],
    [
      "models の中の重複",
      '{"schemaVersion":1,"generatedAt":"2026-11-19T00:00:00Z","source":"models.dev",' +
        '"models":{"openai/a":{"contextWindow":8192},"openai/a":{"contextWindow":99999}}}',
    ],
    [
      "entry の中の重複",
      '{"schemaVersion":1,"generatedAt":"2026-11-19T00:00:00Z","source":"models.dev",' +
        '"models":{"openai/a":{"contextWindow":8192,"contextWindow":99999}}}',
    ],
    [
      "escape で書いた同じ key の重複",
      '{"schemaVersion":1,"generatedAt":"2026-11-19T00:00:00Z","source":"models.dev",' +
        '"models":{"openai/a":{"contextWindow":8192},"openai\\/a":{"contextWindow":1}}}',
    ],
  ])("%s は duplicate-key", (_name, text) => {
    expect(parseCode(text)).toBe("duplicate-key");
  });

  it("別の object に同じ key があるのは重複ではない", () => {
    expect(
      parseCode(
        snapshotText({
          "openai/a": { contextWindow: 8192 },
          "openai/b": { contextWindow: 8192 },
        }),
      ),
    ).toBe("ok");
  });

  it.each([
    ["__proto__", '{"__proto__":{"polluted":true}}'],
    ["constructor", '{"constructor":{"prototype":{"polluted":true}}}'],
    ["prototype", '{"prototype":1}'],
    ["escape で書いた __proto__", '{"\\u005f_proto__":{"polluted":true}}'],
    [
      "models の中の __proto__",
      '{"schemaVersion":1,"generatedAt":"2026-11-19T00:00:00Z","source":"models.dev",' +
        '"models":{"__proto__":{"contextWindow":8192}}}',
    ],
    [
      "entry の中の constructor",
      '{"schemaVersion":1,"generatedAt":"2026-11-19T00:00:00Z","source":"models.dev",' +
        '"models":{"openai/a":{"constructor":1}}}',
    ],
  ])("特殊 key（%s）は forbidden-key で拒否する", (_name, text) => {
    expect(parseCode(text)).toBe("forbidden-key");
  });
});

describe("parseSnapshot：schema と版", () => {
  it.each([2, 0, 99])("知らない schemaVersion（%s）は採用しない", (version) => {
    expect(
      parseCode(snapshotText(GOOD_MODELS, { schemaVersion: version })),
    ).toBe("unsupported-schema-version");
  });

  it("新しい版は他の field の形が違っても版の不採用として扱う", () => {
    expect(
      parseCode('{"schemaVersion":2,"payload":[1,2,3],"models":"new-shape"}'),
    ).toBe("unsupported-schema-version");
  });

  it.each([
    ["文字列の版", { schemaVersion: "1" }],
    ["小数の版", { schemaVersion: 1.5 }],
    ["null の版", { schemaVersion: null }],
    ["source が未知", { source: "somewhere" }],
    ["source が数値", { source: 1 }],
    ["generatedAt が数値", { generatedAt: 1_700_000_000 }],
    ["generatedAt が秒未満を含む", { generatedAt: "2026-11-19T00:00:00.000Z" }],
    ["generatedAt が UTC でない", { generatedAt: "2026-11-19T09:00:00+09:00" }],
    ["generatedAt が日だけ", { generatedAt: "2026-11-19" }],
    ["generatedAt が存在しない日", { generatedAt: "2026-02-30T00:00:00Z" }],
    ["generatedAt の月が範囲外", { generatedAt: "2026-13-01T00:00:00Z" }],
    [
      "generatedAt が文字列でない値を含む",
      { generatedAt: ["2026-11-19T00:00:00Z"] },
    ],
    ["models が配列", { models: [] }],
    ["models が null", { models: null }],
    ["models が文字列", { models: MARKER }],
    ["root に未知の key", { extra: 1 }],
  ])("%s は schema", (_name, overrides) => {
    expect(parseCode(snapshotText(GOOD_MODELS, overrides))).toBe("schema");
  });

  it.each(["schemaVersion", "generatedAt", "source", "models"])(
    "%s が無ければ schema",
    (field) => {
      const object = JSON.parse(snapshotText(GOOD_MODELS)) as Record<
        string,
        unknown
      >;
      delete object[field];
      expect(parseCode(JSON.stringify(object))).toBe("schema");
    },
  );

  it("未来すぎる generatedAt は拒否する", () => {
    expect(
      parseCode(
        snapshotText(GOOD_MODELS, { generatedAt: "2026-11-20T12:00:01Z" }),
      ),
    ).toBe("future-generated-at");
    expect(
      parseCode(
        snapshotText(GOOD_MODELS, { generatedAt: "2999-01-01T00:00:00Z" }),
      ),
    ).toBe("future-generated-at");
  });

  it("nowMs が有限でないのは呼び出し側の誤りとして例外にする", () => {
    expect(() =>
      parseSnapshot(snapshotText(GOOD_MODELS), P, { nowMs: Number.NaN }),
    ).toThrow(TypeError);
  });
});

describe("parseSnapshot：model の検証", () => {
  it.each([
    ["contextWindow が文字列", { contextWindow: "8192" }],
    ["contextWindow が小数", { contextWindow: 8192.5 }],
    ["contextWindow が負", { contextWindow: -1 }],
    ["contextWindow が 0", { contextWindow: 0 }],
    ["contextWindow が下限未満", { contextWindow: 512 }],
    ["contextWindow が上限超過", { contextWindow: 99_999_999 }],
    ["contextWindow が safe integer を超える", { contextWindow: 2 ** 53 }],
    ["contextWindow が null", { contextWindow: null }],
    ["contextWindow が配列", { contextWindow: [8192] }],
    ["maxOutputTokens が下限未満", { maxOutputTokens: 10 }],
    ["maxOutputTokens が上限超過", { maxOutputTokens: 5_000_000 }],
    ["toolCall が文字列", { toolCall: "true" }],
    ["toolCall が数値", { toolCall: 1 }],
    ["reasoning が null", { reasoning: null }],
    [
      "maxOutputTokens が contextWindow を超える",
      { contextWindow: 8192, maxOutputTokens: 16_384 },
    ],
    ["known の field が 1 つも無い", { note: "x" }],
    ["空の entry", {}],
  ])("不正な entry（%s）はその model だけ捨てる", (_name, entry) => {
    const models: Record<string, unknown> = { "openai/bad": entry };
    for (let i = 0; i < 99; i += 1)
      models[`openai/ok${i}`] = { contextWindow: 8192 };
    const result = parseSnapshot(snapshotText(models), P, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.models["openai/bad"]).toBeUndefined();
    expect(Object.keys(result.snapshot.models)).toHaveLength(99);
    expect(result.findings).toContainEqual({
      code: "invalid-model-dropped",
      count: 1,
    });
  });

  it("JSON の数値が無限大に丸まる（1e999）model は捨てる", () => {
    const text =
      '{"schemaVersion":1,"generatedAt":"2026-11-19T00:00:00Z","source":"models.dev","models":{' +
      '"openai/inf":{"contextWindow":1e999},"openai/ok":{"contextWindow":8192},' +
      '"openai/ok2":{"contextWindow":8192}}}';
    const result = parseSnapshot(text, { ...P, maxInvalidRatio: 0.5 }, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.snapshot.models).sort()).toEqual([
      "openai/ok",
      "openai/ok2",
    ]);
  });

  it("entry が object でない（配列・null・数値）なら捨てる", () => {
    const models: Record<string, unknown> = {
      "openai/a": [],
      "openai/b": null,
      "openai/c": 5,
    };
    for (let i = 0; i < 99; i += 1)
      models[`openai/ok${i}`] = { contextWindow: 8192 };
    const result = parseSnapshot(snapshotText(models), P, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.snapshot.models)).toHaveLength(99);
  });

  it("境界の値（下限・上限・maxOutputTokens = contextWindow）は通す", () => {
    const snapshot = parseOk(
      snapshotText({
        "openai/min": { contextWindow: P.minContextWindow },
        "openai/max": { contextWindow: P.maxContextWindow },
        "openai/eq": { contextWindow: 8192, maxOutputTokens: 8192 },
        "openai/outmin": { maxOutputTokens: P.minMaxOutputTokens },
        "openai/outmax": { maxOutputTokens: P.maxMaxOutputTokens },
      }),
    );
    expect(Object.keys(snapshot.models)).toHaveLength(5);
  });

  it.each([
    ["大文字の provider", "OpenAI/gpt"],
    ["slash が無い", "gpt-4.1"],
    ["provider だけ", "openai/"],
    ["先頭が slash", "/openai/gpt"],
    ["空白を含む", "openai/gpt 4"],
    ["改行を含む", "openai/gpt\n4"],
    ["制御文字を含む", "openai/gpt\u0000"],
    ["日本語を含む", "openai/モデル"],
    ["id の先頭が記号", "openai/-gpt"],
    ["id の先頭が _", "openai/__proto__"],
    ["id に _ を含む", "openai/gpt_4"],
    ["id に大文字を含む", "openai/GPT-4"],
    ["id に @ を含む", "openai/gpt@4"],
    ["id に // を含む", "openai/a//b"],
    ["id に slash が 2 つ", "openai/a/b/c"],
    ["id に : が 2 つ", "openai/a:b:c"],
    ["id の : の後に slash", "openai/a:b/c"],
    ["id の末尾が :", "openai/a:"],
    [
      "id が URL の形",
      "openai/https://evil.example/@ignore-previous:instructions",
    ],
    ["id の ~ が先頭でない", "openai/a~b"],
    ["id が constructor", "openai/constructor"],
    ["id が prototype", "openai/prototype"],
    ["id が長すぎる", `openai/${"a".repeat(200)}`],
  ])("key の違反（%s）は model を捨てる", (_name, key) => {
    const models: Record<string, unknown> = { [key]: { contextWindow: 8192 } };
    for (let i = 0; i < 99; i += 1)
      models[`openai/ok${i}`] = { contextWindow: 8192 };
    const result = parseSnapshot(snapshotText(models), P, CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.snapshot.models)).toHaveLength(99);
  });

  it("捨てた割合が上限を超えたらファイル全体を捨てる（境界を含む）", () => {
    const build = (invalid: number): string => {
      const models: Record<string, unknown> = {};
      for (let i = 0; i < 100 - invalid; i += 1) {
        models[`openai/ok${i}`] = { contextWindow: 8192 };
      }
      for (let i = 0; i < invalid; i += 1) {
        models[`openai/bad${i}`] = { contextWindow: "x" };
      }
      return snapshotText(models);
    };
    expect(parseCode(build(5))).toBe("ok");
    expect(parseCode(build(6))).toBe("too-many-invalid");
    expect(parseCode(build(100))).toBe("too-many-invalid");
  });

  it("空の models、有効な model が無い写しは拒否する", () => {
    expect(parseCode(snapshotText({}))).toBe("empty");
  });

  it("件数の上限は対応 provider の entry にだけ当てる（無視する provider は数えない）", () => {
    const models: Record<string, unknown> = {};
    for (let i = 0; i < 20; i += 1) {
      models[`future-provider/Some_ID ${i}`] = { contextWindow: 8192 };
    }
    for (let i = 0; i < 3; i += 1) {
      models[`openai/m${i}`] = { contextWindow: 8192 };
    }
    expect(parseCode(snapshotText(models), { ...P, maxModels: 5 })).toBe("ok");
  });

  it("実在の id の形（実測の 437 件が使う文字・構造）を通す", () => {
    const models: Record<string, unknown> = {};
    for (const key of [
      "anthropic/claude-opus-4-5-20251101",
      "openai/gpt-5.4-mini",
      "openai/o3",
      "sakana/fugu-ultra-20260615",
      "openrouter/cohere/command-r-08-2024",
      "openrouter/liquid/lfm-3-1.7b:free",
      "openrouter/~anthropic/claude-opus-latest",
      "openrouter/openai/gpt-oss-20b:free",
    ]) {
      models[key] = { toolCall: true };
    }
    expect(Object.keys(parseOk(snapshotText(models)).models)).toHaveLength(8);
  });

  it("件数の上限を超えたら too-many-models", () => {
    const models: Record<string, unknown> = {};
    for (let i = 0; i < 6; i += 1)
      models[`openai/m${i}`] = { contextWindow: 8192 };
    expect(parseCode(snapshotText(models), { ...P, maxModels: 5 })).toBe(
      "too-many-models",
    );
  });
});

describe("失敗・成功の結果に応答の本文が出ない", () => {
  const poisoned = [
    snapshotText({ [`openai/${MARKER}`]: { contextWindow: "x" } }),
    snapshotText({ "openai/a": { contextWindow: 8192, [MARKER]: MARKER } }),
    snapshotText(GOOD_MODELS, { source: MARKER }),
    snapshotText(GOOD_MODELS, { generatedAt: MARKER }),
    snapshotText(GOOD_MODELS, { [MARKER]: MARKER }),
    snapshotText(GOOD_MODELS, { schemaVersion: MARKER }),
    `{"schemaVersion":1,"${MARKER}":`,
    `{"${MARKER}":1,"${MARKER}":2}`,
    `{"schemaVersion":2,"${MARKER}":"${MARKER}"}`,
    `${MARKER}`,
  ];
  it.each(poisoned.map((text, index) => [index, text] as const))(
    "入力 %s の結果に marker が含まれない",
    (_index, text) => {
      const result = parseSnapshot(text, P, CTX);
      expect(JSON.stringify(result)).not.toContain(MARKER);
    },
  );

  it("normalize の結果にも出ない", () => {
    const raw = {
      anthropic: {
        name: MARKER,
        models: {
          a: {
            name: MARKER,
            description: MARKER,
            reasoning: MARKER,
            tool_call: true,
            limit: { context: MARKER, output: MARKER },
          },
          b: {
            description: MARKER,
            reasoning: true,
            tool_call: true,
            limit: { context: 200_000, output: 64_000 },
          },
        },
      },
      [MARKER]: { models: { [MARKER]: {} } },
    };
    const result = normalizeModelsDev(raw, P, NORMALIZE_CTX);
    expect(JSON.stringify(result)).not.toContain(MARKER);
  });

  it("失敗は列挙した code だけを持つ", () => {
    const result = parseSnapshot("", P, CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(SNAPSHOT_FAILURE_CODES).toContain(result.code);
    expect(Object.keys(result).sort()).toEqual(["code", "findings", "ok"]);
  });
});

describe("normalizeModelsDev", () => {
  it("手書きの抜粋を写しの形式へ変換する", () => {
    const result = normalizeModelsDev(MODELS_DEV_EXCERPT, P, NORMALIZE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.source).toBe("models.dev");
    expect(result.snapshot.generatedAt).toBe(GENERATED_AT);
    expect({ ...result.snapshot.models }).toEqual({
      "anthropic/claude-fable-5-1": {
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        toolCall: true,
        reasoning: true,
      },
      "openai/gpt-4.1": {
        contextWindow: 1_047_576,
        maxOutputTokens: 32_768,
        toolCall: true,
        reasoning: false,
      },
      // limit が 0（不明）の model は、limit を返さずに tool／reasoning だけを持つ。
      "openai/gpt-unknown-limit": { toolCall: true, reasoning: true },
      "openrouter/~anthropic/claude-opus-latest": {
        contextWindow: 1_000_000,
        maxOutputTokens: 128_000,
        toolCall: true,
        reasoning: true,
      },
      "openrouter/cohere/command-a": {
        contextWindow: 256_000,
        maxOutputTokens: 8_192,
        toolCall: false,
        reasoning: false,
      },
      "sakana/fugu": {
        contextWindow: 1_000_000,
        maxOutputTokens: 1_000_000,
        toolCall: true,
        reasoning: true,
      },
    });
    // 対応外の provider（2 つ）と chat 以外の model（1 件）は無視として数える。
    expect(result.findings).toEqual([
      { code: "ignored-provider", count: 2 },
      { code: "ignored-non-chat-model", count: 1 },
      { code: "unknown-limit-omitted", count: 2 },
    ]);
  });

  it("変換した写しは canonicalize → parseSnapshot を通り、同じ内容に戻る", () => {
    const result = normalizeModelsDev(MODELS_DEV_EXCERPT, P, NORMALIZE_CTX);
    if (!result.ok) throw new Error("normalize failed");
    const canonical = canonicalize(result.snapshot);
    const parsed = parseSnapshot(canonical, P, CTX);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.findings).toEqual([]);
    expect(canonicalize(parsed.snapshot)).toBe(canonical);
  });

  it("models.dev の本文（text）から parse → 変換できる", () => {
    const parsed = parseModelsDevText(JSON.stringify(MODELS_DEV_EXCERPT), P);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = normalizeModelsDev(parsed.value, P, NORMALIZE_CTX);
    expect(result.ok).toBe(true);
  });

  it("対応表に無い provider は捨てる（__proto__／constructor という名前でも）", () => {
    const raw = JSON.parse(
      '{"__proto__":{"models":{"a":{"limit":{"context":8192}}}},' +
        '"constructor":{"models":{"a":{"limit":{"context":8192}}}},' +
        '"openai":{"models":{"gpt":{"reasoning":true,"tool_call":true}}}}',
    ) as unknown;
    const result = normalizeModelsDev(raw, P, NORMALIZE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.snapshot.models)).toEqual(["openai/gpt"]);
    expect(result.findings).toContainEqual({
      code: "ignored-provider",
      count: 2,
    });
  });

  it("型違い・範囲外の model は捨て、割合の内なら残りを返す", () => {
    const models: Record<string, unknown> = {};
    for (let i = 0; i < 99; i += 1) {
      models[`ok${i}`] = { reasoning: true, tool_call: true };
    }
    models.stringLimit = { limit: { context: "8192" }, tool_call: true };
    const result = normalizeModelsDev({ openai: { models } }, P, NORMALIZE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.snapshot.models)).toHaveLength(99);
    expect(result.findings).toContainEqual({
      code: "invalid-model-dropped",
      count: 1,
    });
  });

  it.each([
    ["context が小数", { limit: { context: 8192.5 } }],
    ["context が負", { limit: { context: -5 } }],
    ["context が記号の 99999999", { limit: { context: 99_999_999 } }],
    [
      "output が context を超える",
      { limit: { context: 8192, output: 16_384 } },
    ],
    ["tool_call が文字列", { tool_call: "yes" }],
    ["reasoning が数値", { reasoning: 1 }],
    ["limit が配列", { limit: [8192] }],
    ["limit が文字列", { limit: "8192" }],
  ])("不正（%s）が割合の上限を超えると全体を捨てる", (_name, bad) => {
    const models: Record<string, unknown> = {};
    for (let i = 0; i < 10; i += 1) models[`bad${i}`] = bad;
    models.good = { reasoning: true };
    const result = normalizeModelsDev({ openai: { models } }, P, NORMALIZE_CTX);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too-many-invalid");
  });

  it("type が文字列でない model は型違いの不正（無視でなく分母に入れる）", () => {
    const models: Record<string, unknown> = {};
    for (let i = 0; i < 99; i += 1) {
      models[`ok${i}`] = { reasoning: true, tool_call: true };
    }
    models.numType = { type: 1, reasoning: true, tool_call: true };
    const few = normalizeModelsDev({ openai: { models } }, P, NORMALIZE_CTX);
    expect(few.ok).toBe(true);
    if (!few.ok) return;
    expect(few.findings).toContainEqual({
      code: "invalid-model-dropped",
      count: 1,
    });
    expect(few.findings.map((f) => f.code)).not.toContain(
      "ignored-non-chat-model",
    );
    // 全て type が配列・null・object なら、割合の超過で全体を捨てる（blank 化の攻撃）。
    const blanked = {
      openai: {
        models: Object.fromEntries(
          [[], null, {}, true, 0, 1.5].map((type, i) => [
            `m${i}`,
            { type, reasoning: true, tool_call: true },
          ]),
        ),
      },
    };
    expect(normalizeModelsDev(blanked, P, NORMALIZE_CTX)).toMatchObject({
      ok: false,
      code: "too-many-invalid",
    });
  });

  it("対応 provider の model が全て無視・不正なら empty", () => {
    const result = normalizeModelsDev(
      { openai: { models: { e: { type: "embedding", reasoning: false } } } },
      P,
      NORMALIZE_CTX,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("empty");
  });

  it("対応表の provider が 1 つも無い応答は empty", () => {
    const result = normalizeModelsDev(
      { other: { models: {} } },
      P,
      NORMALIZE_CTX,
    );
    expect(result).toMatchObject({ ok: false, code: "empty" });
  });

  it.each([
    ["null", null],
    ["配列", []],
    ["文字列", "x"],
    ["対応 provider が配列", { openai: [] }],
    ["対応 provider の models が無い", { openai: {} }],
    ["対応 provider の models が配列", { openai: { models: [] } }],
  ])("構造が違う応答（%s）は schema", (_name, raw) => {
    const result = normalizeModelsDev(raw, P, NORMALIZE_CTX);
    expect(result).toMatchObject({ ok: false, code: "schema" });
  });

  it("generatedAt の形式違いは schema", () => {
    const result = normalizeModelsDev(MODELS_DEV_EXCERPT, P, {
      generatedAt: "yesterday",
      source: "models.dev",
    });
    expect(result).toMatchObject({ ok: false, code: "schema" });
  });

  it("source は呼び出し側が渡した値を写しに刻み、その写しは parseSnapshot で同じ source になる", () => {
    for (const source of ["models.dev", "grimodex"] as const) {
      const result = normalizeModelsDev(MODELS_DEV_EXCERPT, P, {
        generatedAt: GENERATED_AT,
        source,
      });
      if (!result.ok) throw new Error("normalize failed");
      expect(result.snapshot.source).toBe(source);
      const parsed = parseSnapshot(canonicalize(result.snapshot), P, CTX);
      expect(parsed.ok && parsed.snapshot.source).toBe(source);
    }
  });

  it("未知の source は schema", () => {
    const result = normalizeModelsDev(MODELS_DEV_EXCERPT, P, {
      generatedAt: GENERATED_AT,
      source: "somewhere" as unknown as "models.dev",
    });
    expect(result).toMatchObject({ ok: false, code: "schema" });
  });

  it("規模の上限（provider 数・provider あたりの model 数・変換後の件数）を超えたら止める", () => {
    expect(
      normalizeModelsDev(
        MODELS_DEV_EXCERPT,
        { ...P, maxRawProviders: 3 },
        NORMALIZE_CTX,
      ),
    ).toMatchObject({ ok: false, code: "too-large" });
    expect(
      normalizeModelsDev(
        MODELS_DEV_EXCERPT,
        { ...P, maxRawModelsPerProvider: 1 },
        NORMALIZE_CTX,
      ),
    ).toMatchObject({ ok: false, code: "too-large" });
    expect(
      normalizeModelsDev(
        MODELS_DEV_EXCERPT,
        { ...P, maxModels: 2 },
        NORMALIZE_CTX,
      ),
    ).toMatchObject({ ok: false, code: "too-many-models" });
  });
});

describe("parseModelsDevText", () => {
  it("byte 数・深さ・構文の違反を code で返す", () => {
    expect(
      parseModelsDevText("x".repeat(20), { ...P, maxRawBytes: 10 }),
    ).toMatchObject({ ok: false, code: "too-large" });
    expect(parseModelsDevText("[".repeat(1000), P)).toMatchObject({
      ok: false,
      code: "too-deep",
    });
    expect(parseModelsDevText("{", P)).toMatchObject({
      ok: false,
      code: "syntax",
    });
    expect(parseModelsDevText("not json", P)).toMatchObject({
      ok: false,
      code: "syntax",
    });
  });

  it("重複 key は後の値を採用し、特殊 key は自前の property として読み、対応外の provider で全体を捨てない", () => {
    const parsed = parseModelsDevText(
      '{"x":{"models":{}},"x":{"models":{}},"__proto__":{"y":1},' +
        '"openai":{"models":{"old":{"reasoning":true}}},' +
        '"openai":{"models":{"gpt":{"reasoning":true,"tool_call":true},' +
        '"gpt":{"reasoning":false,"tool_call":true}}}}',
      P,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = normalizeModelsDev(parsed.value, P, NORMALIZE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 後の `openai`（old は無い）と、その中の後の `gpt`（reasoning: false）が採用される。
    expect({ ...result.snapshot.models }).toEqual({
      "openai/gpt": { toolCall: true, reasoning: false },
    });
    expect(result.findings).toContainEqual({
      code: "ignored-provider",
      count: 2,
    });
  });
});

describe("prototype の汚染（module の内部で key を代入する経路）", () => {
  const prototypeKeys = (): string[] =>
    Object.getOwnPropertyNames(Object.prototype).sort();

  it("normalize は特殊な model id・limit の特殊 key を代入・参照せず、prototype を汚さない", () => {
    const before = prototypeKeys();
    const models: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) {
      models[`ok${i}`] = { reasoning: true, tool_call: true };
    }
    const raw = JSON.parse(
      JSON.stringify({ openai: { models } }).replace(
        '"models":{',
        '"models":{"__proto__":{"reasoning":true,"toolCall":true},' +
          '"constructor":{"reasoning":true},"prototype":{"reasoning":true},' +
          '"vialimit":{"reasoning":true,"limit":{"__proto__":{"context":8192,"output":4096}}},',
      ),
    ) as unknown;
    const result = normalizeModelsDev(raw, P, NORMALIZE_CTX);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { models: out } = result.snapshot;
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(Object.keys(out)).not.toContain("openai/__proto__");
    expect(Object.keys(out)).not.toContain("openai/constructor");
    expect(Object.keys(out)).not.toContain("openai/prototype");
    // 継承された property を limit の値として拾わない。
    expect(out["openai/vialimit"]).toEqual({ reasoning: true });
    expect(out["constructor"]).toBeUndefined();
    expect(({} as Record<string, unknown>).reasoning).toBeUndefined();
    expect(({} as Record<string, unknown>).toolCall).toBeUndefined();
    expect(prototypeKeys()).toEqual(before);
    // 直列化と再検証を通しても同じ。
    const parsed = parseSnapshot(canonicalize(result.snapshot), P, CTX);
    expect(parsed.ok).toBe(true);
    expect(prototypeKeys()).toEqual(before);
  });

  it("parseSnapshot の結果の models は prototype を持たず、代入の経路で prototype を汚さない", () => {
    const before = prototypeKeys();
    const snapshot = parseOk(snapshotText(GOOD_MODELS));
    expect(Object.getPrototypeOf(snapshot.models)).toBeNull();
    expect(snapshot.models["constructor"]).toBeUndefined();
    expect(snapshot.models["__proto__"]).toBeUndefined();
    expect(canonicalize(snapshot)).not.toContain("__proto__");
    expect(prototypeKeys()).toEqual(before);
  });
});

describe("compareSnapshots", () => {
  const LATER = "2026-11-19T01:00:00Z";
  const entry = (extra: ModelEntry = {}): ModelEntry => ({
    contextWindow: 100_000,
    maxOutputTokens: 8192,
    toolCall: true,
    ...extra,
  });
  const range = (
    provider: string,
    prefix: string,
    count: number,
  ): Record<string, ModelEntry> =>
    Object.fromEntries(
      Array.from({ length: count }, (_value, i) => [
        `${provider}/${prefix}${i}`,
        entry(),
      ]),
    );
  const base = makeSnapshot(range("openai", "m", 12));
  /** 比較される側（previous）より新しい写し。 */
  const later = (models: Record<string, ModelEntry>): Snapshot =>
    makeSnapshot(models, LATER);
  const copyOf = (snapshot: Snapshot): Record<string, ModelEntry> => ({
    ...snapshot.models,
  });

  it("同じ写しとの比較は findings なしで通る（同時刻・同内容は古さに数えない）", () => {
    expect(compareSnapshots(base, base, P)).toEqual({ ok: true, findings: [] });
    expect(
      compareSnapshots(base, makeSnapshot(range("openai", "m", 12)), P),
    ).toEqual({ ok: true, findings: [] });
  });

  it("採用済みより古い写しは stale", () => {
    const older = makeSnapshot(copyOf(base), "2026-11-18T23:59:59Z");
    expect(compareSnapshots(base, older, P)).toMatchObject({
      ok: false,
      code: "stale",
    });
  });

  it("新しい写しは通る", () => {
    expect(compareSnapshots(base, later(copyOf(base)), P).ok).toBe(true);
  });

  it("同じ generatedAt で中身が違う写しは generated-at-conflict", () => {
    const changed = makeSnapshot({
      ...copyOf(base),
      "openai/m0": entry({ toolCall: false }),
    });
    const result = compareSnapshots(base, changed, P);
    expect(result).toMatchObject({ ok: false, code: "generated-at-conflict" });
    expect(SNAPSHOT_FAILURE_CATEGORY["generated-at-conflict"]).toBe(
      "freshness",
    );
    // source だけが違っても内容（正規形）が違う。
    const otherSource = parseOk(
      snapshotText(copyOf(base), { source: "grimodex" }),
    );
    expect(compareSnapshots(base, otherSource, P)).toMatchObject({
      ok: false,
      code: "generated-at-conflict",
    });
  });

  it("件数が半分未満に減ったら shrunk、半分ちょうどは通す", () => {
    const keep = (n: number): Snapshot => later(range("openai", "m", n));
    const shrunk = compareSnapshots(base, keep(5), P);
    expect(shrunk).toMatchObject({ ok: false, code: "shrunk" });
    expect(shrunk.findings).toContainEqual({
      code: "model-count-dropped",
      from: 12,
      to: 5,
    });
    expect(compareSnapshots(base, keep(6), P).ok).toBe(true);
  });

  it("id を総入れ替えした写しは、件数が同じでも shrunk（保持率）", () => {
    const previous = makeSnapshot(
      Object.fromEntries(
        Array.from({ length: 50 }, (_v, i) => [`openai/gpt-${i}`, entry()]),
      ),
    );
    const next = later(
      Object.fromEntries(
        Array.from({ length: 50 }, (_v, i) => [`openai/junk-${i}`, entry()]),
      ),
    );
    const result = compareSnapshots(previous, next, P);
    expect(result).toMatchObject({ ok: false, code: "shrunk" });
    expect(result.findings).toContainEqual({
      code: "model-retention-dropped",
      from: 50,
      to: 0,
    });
  });

  it("保持率は半分ちょうどなら通す", () => {
    const next = later({
      ...range("openai", "m", 6),
      ...range("openai", "n", 6),
    });
    expect(compareSnapshots(base, next, P).ok).toBe(true);
    const worse = later({
      ...range("openai", "m", 5),
      ...range("openai", "n", 7),
    });
    expect(compareSnapshots(base, worse, P)).toMatchObject({
      ok: false,
      code: "shrunk",
    });
  });

  it("provider 単位の急減は、全体が閾値の内でも shrunk", () => {
    const models = {
      ...range("anthropic", "a", 12),
      ...range("openrouter", "o", 100),
    };
    const previous = makeSnapshot(models);
    const nextModels = { ...models };
    for (let i = 0; i < 12; i += 1) delete nextModels[`anthropic/a${i}`];
    const result = compareSnapshots(previous, later(nextModels), P);
    expect(result).toMatchObject({ ok: false, code: "shrunk" });
    expect(result.findings).toEqual([
      { code: "provider-count-dropped", key: "anthropic", from: 12, to: 0 },
      { code: "provider-retention-dropped", key: "anthropic", from: 12, to: 0 },
    ]);
  });

  it("provider の中の id の入れ替えは、全体の保持率が高くても shrunk", () => {
    const previous = makeSnapshot({
      ...range("anthropic", "a", 12),
      ...range("openrouter", "o", 100),
    });
    const next = later({
      ...range("anthropic", "x", 12),
      ...range("openrouter", "o", 100),
    });
    const result = compareSnapshots(previous, next, P);
    expect(result).toMatchObject({ ok: false, code: "shrunk" });
    expect(result.findings).toEqual([
      {
        code: "provider-retention-dropped",
        key: "anthropic",
        from: 12,
        to: 0,
      },
    ]);
  });

  it("小さい provider（基準の件数未満）の全消失は拒否せず、provider-removed に出す", () => {
    const models = {
      ...range("sakana", "s", 4),
      ...range("openrouter", "o", 100),
    };
    const previous = makeSnapshot(models);
    const nextModels = { ...models };
    for (let i = 0; i < 4; i += 1) delete nextModels[`sakana/s${i}`];
    const result = compareSnapshots(previous, later(nextModels), P);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toEqual([
      { code: "provider-removed", key: "sakana", from: 4 },
      { code: "models-removed", count: 4 },
    ]);
  });

  it("context の大きな変化・能力の反転・追加と削除を findings に出す（捨てない）", () => {
    const next = later({
      ...(Object.fromEntries(
        Object.entries(base.models).filter(([key]) => key !== "openai/m11"),
      ) as Record<string, ModelEntry>),
      "openai/m0": entry({ contextWindow: 400_000 }), // ちょうど 4 倍
      "openai/m1": entry({ contextWindow: 25_000 }), // 1/4
      "openai/m2": entry({ contextWindow: 399_999 }), // 4 倍未満
      "openai/m3": entry({ toolCall: false }),
      "openai/m4": entry({ reasoning: true }),
      "openai/new": { contextWindow: 100_000 },
    });
    const result = compareSnapshots(base, next, P);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toEqual([
      { code: "context-changed", key: "openai/m0", from: 100_000, to: 400_000 },
      { code: "context-changed", key: "openai/m1", from: 100_000, to: 25_000 },
      {
        code: "capability-changed",
        key: "openai/m3",
        field: "toolCall",
        from: true,
        to: false,
      },
      { code: "models-added", count: 1 },
      { code: "models-removed", count: 1 },
    ]);
  });

  it("値から「返さない」への変化（field の削除）を全ての field で findings に出す", () => {
    const previous = makeSnapshot({
      ...copyOf(base),
      "openai/full": {
        contextWindow: 100_000,
        maxOutputTokens: 8192,
        toolCall: true,
        reasoning: false,
      },
    });
    const next = later({
      ...copyOf(previous),
      "openai/full": { contextWindow: 100_000 },
      "openai/m0": { contextWindow: 100_000, maxOutputTokens: 8192 },
    });
    const result = compareSnapshots(previous, next, P);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toEqual([
      {
        code: "field-removed",
        key: "openai/full",
        field: "maxOutputTokens",
        from: 8192,
      },
      {
        code: "field-removed",
        key: "openai/full",
        field: "toolCall",
        from: true,
      },
      {
        code: "field-removed",
        key: "openai/full",
        field: "reasoning",
        from: false,
      },
      {
        code: "field-removed",
        key: "openai/m0",
        field: "toolCall",
        from: true,
      },
    ]);
  });

  it("値のなかった field が増えるのは field の削除ではない", () => {
    const previous = makeSnapshot({
      ...copyOf(base),
      "openai/sparse": { contextWindow: 100_000 },
    });
    const next = later({
      ...copyOf(previous),
      "openai/sparse": entry({ reasoning: true }),
    });
    expect(compareSnapshots(previous, next, P)).toEqual({
      ok: true,
      findings: [],
    });
  });

  it("findings は maxFindings で切り、超えた件数を残す", () => {
    const next = later(
      Object.fromEntries(
        Array.from({ length: 12 }, (_value, i) => [
          `openai/m${i}`,
          entry({ contextWindow: 1_000_000 }),
        ]),
      ),
    );
    const result = compareSnapshots(base, next, { ...P, maxFindings: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(6);
    expect(result.findings[5]).toEqual({
      code: "findings-truncated",
      count: 7,
    });
  });

  it("悪意の key は parseSnapshot で弾かれ、compare の findings に出ない", () => {
    const evil = "openai/https://evil.example/@ignore-previous:instructions";
    const models: Record<string, unknown> = {};
    for (let i = 0; i < 100; i += 1) models[`openai/m${i}`] = entry();
    const previous = parseOk(snapshotText(models));
    models[evil] = { contextWindow: 100_000 };
    models["openai/m0"] = entry({ contextWindow: 1_000_000 });
    const next = parseOk(snapshotText(models, { generatedAt: LATER }));
    expect(next.models[evil]).toBeUndefined();
    const result = compareSnapshots(previous, next, P);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("evil");
  });

  it("検証を通っていない写し（悪意の key）を直接渡されても、key を出さず schema で拒否する", () => {
    const evil = "openai/https://evil.example/@ignore-previous:instructions";
    const forged = {
      schemaVersion: 1,
      generatedAt: LATER,
      source: "models.dev",
      models: { ...copyOf(base), [evil]: { contextWindow: 1_000_000 } },
    } as unknown as Snapshot;
    for (const result of [
      compareSnapshots(base, forged, P),
      compareSnapshots(forged, base, P),
    ]) {
      expect(result).toMatchObject({ ok: false, code: "schema" });
      expect(JSON.stringify(result)).not.toContain("evil");
    }
  });
});
