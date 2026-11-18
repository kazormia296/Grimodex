import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SNAPSHOT_POLICY } from "../shared/modelCapabilityRegistry.js";
import { MODEL_CAPABILITY_FETCH_HOST } from "./modelCapabilityFetch.js";
import {
  MODEL_CAPABILITY_CACHE_FILE,
  createModelCapabilityStore,
  sha256OfText,
  type ModelCapabilityStore,
} from "./modelCapabilityStore.js";
import {
  BUNDLED_GENERATED_AT,
  NEWER_GENERATED_AT,
  TEST_NOW,
  makeModels,
  makeTempDir,
  snapshotText,
  writeBundled,
} from "./modelCapability.testSupport.js";

let temp: ReturnType<typeof makeTempDir>;
let store: ModelCapabilityStore;
let cachePath: string;
const TMP_UUID = "0b9f6a3e-6d1c-4f0e-9a37-2c5b8d4e1f70";
const bundledModels = makeModels(12);
const bundledText = snapshotText(bundledModels, BUNDLED_GENERATED_AT);

beforeEach(() => {
  temp = makeTempDir();
  cachePath = path.join(temp.dir, MODEL_CAPABILITY_CACHE_FILE);
  store = createModelCapabilityStore({
    cacheDir: temp.dir,
    bundledPath: writeBundled(temp.dir, bundledText),
  });
});
afterEach(() => temp.cleanup());

function writeEnvelope(
  body: string,
  overrides: Record<string, unknown> = {},
): void {
  writeFileSync(
    cachePath,
    JSON.stringify({
      schemaVersion: 1,
      fetchedAt: "2026-11-19T01:00:00.000Z",
      fetchedFrom: MODEL_CAPABILITY_FETCH_HOST,
      bodySha256: sha256OfText(body),
      body,
      ...overrides,
    }),
    "utf8",
  );
}

const newerText = snapshotText(
  { ...bundledModels, ...makeModels(2, "openai", 100) },
  NEWER_GENERATED_AT,
);

describe("同梱の写し", () => {
  it("読めて、検証を通る", () => {
    const result = store.loadBundled(TEST_NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.snapshot.models)).toHaveLength(12);
    }
  });

  it("file が無ければ unreadable（main は落ちない）", () => {
    const missing = createModelCapabilityStore({
      cacheDir: temp.dir,
      bundledPath: path.join(temp.dir, "nothing.json"),
    });
    expect(missing.loadBundled(TEST_NOW)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("壊れた同梱は invalid、source が grimodex でなければ source で失敗する", () => {
    const broken = createModelCapabilityStore({
      cacheDir: temp.dir,
      bundledPath: writeBundled(temp.dir, "{not json"),
    });
    expect(broken.loadBundled(TEST_NOW)).toEqual({
      ok: false,
      reason: "invalid:syntax",
    });
    const foreign = createModelCapabilityStore({
      cacheDir: temp.dir,
      bundledPath: writeBundled(
        temp.dir,
        snapshotText(bundledModels, BUNDLED_GENERATED_AT, {
          source: "models.dev",
        }),
      ),
    });
    expect(foreign.loadBundled(TEST_NOW)).toEqual({
      ok: false,
      reason: "source",
    });
  });

  it("利用者の時計が大きく古いと future-generated-at で失敗する（落ちない）", () => {
    const result = store.loadBundled(
      Date.parse(BUNDLED_GENERATED_AT) - 3 * 86_400_000,
    );
    expect(result).toEqual({
      ok: false,
      reason: "invalid:future-generated-at",
    });
  });

  it("上限を超える file は読まない", () => {
    const huge = createModelCapabilityStore({
      cacheDir: temp.dir,
      bundledPath: writeBundled(
        temp.dir,
        " ".repeat(SNAPSHOT_POLICY.maxSnapshotBytes + 1),
      ),
    });
    expect(huge.loadBundled(TEST_NOW)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });
});

describe("cache の書込み", () => {
  it("tmp＋rename で書き、読み直すと同じ写しを返す。tmp は残らない", () => {
    expect(store.writeCache(newerText, TEST_NOW, () => true)).toBe(true);
    expect(readdirSync(temp.dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    const envelope = JSON.parse(readFileSync(cachePath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(envelope).toEqual({
      schemaVersion: 1,
      fetchedAt: new Date(TEST_NOW).toISOString(),
      fetchedFrom: "raw.githubusercontent.com",
      bodySha256: sha256OfText(newerText),
      body: newerText,
    });
    const read = store.readCache(TEST_NOW);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.snapshot.generatedAt).toBe(NEWER_GENERATED_AT);
      expect(read.fetchedAt).toBe(new Date(TEST_NOW).toISOString());
    }
  });

  it("guard が false なら rename せず、cache も tmp も残さない（旧 cache はそのまま）", () => {
    expect(store.writeCache(newerText, TEST_NOW, () => true)).toBe(true);
    const before = readFileSync(cachePath, "utf8");
    const newest = snapshotText(
      { ...bundledModels, ...makeModels(3, "openai", 200) },
      "2026-11-19T06:00:00Z",
    );
    expect(store.writeCache(newest, TEST_NOW, () => false)).toBe(false);
    expect(readFileSync(cachePath, "utf8")).toBe(before);
    expect(readdirSync(temp.dir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("cache が無い状態で guard が false なら、何も作らない", () => {
    expect(store.writeCache(newerText, TEST_NOW, () => false)).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });

  it("書込みの途中で kill されて残った tmp は、読むときに無視され、purge で消える", () => {
    const orphan = path.join(
      temp.dir,
      `${MODEL_CAPABILITY_CACHE_FILE}.4242.${TMP_UUID}.tmp`,
    );
    writeFileSync(orphan, '{"half', "utf8");
    expect(store.readCache(TEST_NOW)).toEqual({ ok: false, reason: "absent" });
    // 有効に見える envelope が tmp に残っていても、採用しない。
    writeEnvelope(newerText);
    const valid = readFileSync(cachePath, "utf8");
    writeFileSync(orphan, valid, "utf8");
    rmSync(cachePath, { force: true });
    expect(store.readCache(TEST_NOW)).toEqual({ ok: false, reason: "absent" });
    store.purgeCache();
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("cache の読込み時の検証（保存済みでも未検証として扱う）", () => {
  it("同梱より新しい有効な cache は採用する", () => {
    writeEnvelope(newerText);
    const read = store.readCache(TEST_NOW);
    expect(read.ok).toBe(true);
  });

  it("本文が書き換えられていたら digest の不一致で棄却し、file を消す", () => {
    writeEnvelope(newerText, {
      body: newerText.replace(
        '"contextWindow":100000',
        '"contextWindow":100001',
      ),
    });
    expect(store.readCache(TEST_NOW)).toEqual({ ok: false, reason: "digest" });
    expect(existsSync(cachePath)).toBe(false);
  });

  it("digest が本文に合っていても、検証を通らない本文は棄却する（schema）", () => {
    writeEnvelope("{ not json");
    expect(store.readCache(TEST_NOW)).toEqual({
      ok: false,
      reason: "invalid:syntax",
    });
    expect(existsSync(cachePath)).toBe(false);
  });

  it("壊れた JSON・形の違う envelope・余分な key は envelope で棄却する", () => {
    writeFileSync(cachePath, '{"schemaVersion":1,"body":', "utf8");
    expect(store.readCache(TEST_NOW)).toEqual({
      ok: false,
      reason: "envelope",
    });
    writeEnvelope(newerText, { extra: 1 });
    expect(store.readCache(TEST_NOW)).toEqual({
      ok: false,
      reason: "envelope",
    });
    writeEnvelope(newerText, { schemaVersion: 2 });
    expect(store.readCache(TEST_NOW)).toEqual({
      ok: false,
      reason: "envelope",
    });
    writeEnvelope(newerText, { fetchedAt: "yesterday" });
    expect(store.readCache(TEST_NOW)).toEqual({
      ok: false,
      reason: "envelope",
    });
    writeEnvelope(newerText, { bodySha256: "ABC" });
    expect(store.readCache(TEST_NOW)).toEqual({
      ok: false,
      reason: "envelope",
    });
  });

  it("取得元（host）が違う cache は混ぜず棄却する（Q14）", () => {
    writeEnvelope(newerText, { fetchedFrom: "models.dev" });
    expect(store.readCache(TEST_NOW)).toEqual({ ok: false, reason: "origin" });
    expect(existsSync(cachePath)).toBe(false);
  });

  it("source が grimodex でない写しは、digest が合っていても棄却する（T8）", () => {
    writeEnvelope(
      snapshotText(makeModels(14), NEWER_GENERATED_AT, {
        source: "models.dev",
      }),
    );
    expect(store.readCache(TEST_NOW)).toEqual({ ok: false, reason: "source" });
  });

  it("同梱より古い cache（app の更新で同梱が進んだ）は採用せず、消す", () => {
    writeEnvelope(snapshotText(makeModels(12), "2026-11-10T00:00:00Z"));
    expect(store.readCache(TEST_NOW)).toEqual({
      ok: false,
      reason: "rejected:stale",
    });
    expect(existsSync(cachePath)).toBe(false);
  });

  it("同梱と同じ日時で中身が違う cache は採用しない", () => {
    writeEnvelope(snapshotText(makeModels(13), BUNDLED_GENERATED_AT));
    expect(store.readCache(TEST_NOW)).toEqual({
      ok: false,
      reason: "rejected:generated-at-conflict",
    });
  });

  it("同梱に対して急減している cache は採用しない", () => {
    writeEnvelope(snapshotText(makeModels(4), NEWER_GENERATED_AT));
    expect(store.readCache(TEST_NOW)).toEqual({
      ok: false,
      reason: "rejected:shrunk",
    });
  });

  it("上限を超える file は読まずに棄却する", () => {
    writeFileSync(
      cachePath,
      " ".repeat(SNAPSHOT_POLICY.maxSnapshotBytes * 4 + 1),
      "utf8",
    );
    expect(store.readCache(TEST_NOW)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("cache が無ければ absent", () => {
    expect(store.readCache(TEST_NOW)).toEqual({ ok: false, reason: "absent" });
  });

  it("同梱が読めない間は比べる基準が無いので採用せず、cache は消さない", () => {
    writeEnvelope(newerText);
    const noBundled = createModelCapabilityStore({
      cacheDir: temp.dir,
      bundledPath: path.join(temp.dir, "nothing.json"),
    });
    expect(noBundled.readCache(TEST_NOW)).toEqual({
      ok: false,
      reason: "no-baseline",
    });
    expect(existsSync(cachePath)).toBe(true);
  });
});

describe("purge", () => {
  it("cache と tmp の残骸を消し、再度呼んでも投げない", () => {
    expect(store.writeCache(newerText, TEST_NOW, () => true)).toBe(true);
    writeFileSync(
      path.join(temp.dir, `${MODEL_CAPABILITY_CACHE_FILE}.1.${TMP_UUID}.tmp`),
      "x",
      "utf8",
    );
    store.purgeCache();
    store.purgeCache();
    expect(
      readdirSync(temp.dir).filter((n) =>
        n.startsWith(MODEL_CAPABILITY_CACHE_FILE),
      ),
    ).toEqual([]);
    // 同梱の写し（別の file）は消さない。
    expect(store.loadBundled(TEST_NOW).ok).toBe(true);
  });
});

describe("crash で残った tmp の片付け（起動時）", () => {
  const DECOYS = [
    // 他の module の tmp（keyStore）。
    `ai-keys.json.4242.${TMP_UUID}.tmp`,
    // 基準の名前が違う。
    `other-cache.json.4242.${TMP_UUID}.tmp`,
    `prefix-${MODEL_CAPABILITY_CACHE_FILE}.4242.${TMP_UUID}.tmp`,
    // 形が違う（pid が数でない、UUID でない、拡張子が違う、pid 抜け）。
    `${MODEL_CAPABILITY_CACHE_FILE}.abc.${TMP_UUID}.tmp`,
    `${MODEL_CAPABILITY_CACHE_FILE}.4242.not-a-uuid.tmp`,
    `${MODEL_CAPABILITY_CACHE_FILE}.4242.${TMP_UUID}.bak`,
    `${MODEL_CAPABILITY_CACHE_FILE}.${TMP_UUID}.tmp`,
    `${MODEL_CAPABILITY_CACHE_FILE}.tmp`,
    `${MODEL_CAPABILITY_CACHE_FILE}.4242.${TMP_UUID}.tmp.keep`,
    // 設定 file の tmp は、cache の片付けの対象ではない。
    `model-info-settings.json.4242.${TMP_UUID}.tmp`,
    "license.json",
  ];

  it("自分の命名規則に完全一致する tmp だけを消し、他の file・cache 本体には触れない", () => {
    expect(store.writeCache(newerText, TEST_NOW, () => true)).toBe(true);
    const orphans = [
      `${MODEL_CAPABILITY_CACHE_FILE}.4242.${TMP_UUID}.tmp`,
      `${MODEL_CAPABILITY_CACHE_FILE}.99999.${TMP_UUID.toUpperCase()}.tmp`,
    ];
    for (const name of [...orphans, ...DECOYS]) {
      writeFileSync(path.join(temp.dir, name), "x", "utf8");
    }
    // directory は、名前が一致しても消さない。
    const dirName = `${MODEL_CAPABILITY_CACHE_FILE}.7.${TMP_UUID}.tmp`;
    mkdirSync(path.join(temp.dir, dirName));
    const before = readFileSync(cachePath, "utf8");

    expect(store.removeStaleTemporaryFiles()).toBe(orphans.length);

    for (const name of orphans) {
      expect(existsSync(path.join(temp.dir, name))).toBe(false);
    }
    for (const name of DECOYS) {
      expect(existsSync(path.join(temp.dir, name))).toBe(true);
    }
    expect(existsSync(path.join(temp.dir, dirName))).toBe(true);
    expect(readFileSync(cachePath, "utf8")).toBe(before);
    // 同梱の写し（別の file）も残る。
    expect(store.loadBundled(TEST_NOW).ok).toBe(true);
  });

  it("purgeCache も同じ規則で、他の file の tmp を消さない", () => {
    for (const name of DECOYS) {
      writeFileSync(path.join(temp.dir, name), "x", "utf8");
    }
    store.purgeCache();
    for (const name of DECOYS) {
      expect(existsSync(path.join(temp.dir, name))).toBe(true);
    }
  });

  it("directory が無くても投げない", () => {
    const missing = createModelCapabilityStore({
      cacheDir: path.join(temp.dir, "nothing"),
      bundledPath: path.join(temp.dir, "nothing.json"),
    });
    expect(missing.removeStaleTemporaryFiles()).toBe(0);
  });
});
