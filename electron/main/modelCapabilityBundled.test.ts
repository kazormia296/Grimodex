import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SNAPSHOT_PROVIDERS,
  SNAPSHOT_POLICY,
  parseSnapshot,
} from "../shared/modelCapabilityRegistry.js";
import { MODEL_CAPABILITY_SNAPSHOT_REPO_PATH } from "./modelCapabilityFetch.js";
import { resolveBundledSnapshotPath } from "./modelCapabilityRuntime.js";
import { createModelCapabilityStore } from "./modelCapabilityStore.js";
import { makeTempDir } from "./modelCapability.testSupport.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const bundledFile = path.join(repoRoot, MODEL_CAPABILITY_SNAPSHOT_REPO_PATH);
const scriptFile = path.join(
  repoRoot,
  "scripts",
  "generate-model-capability-snapshot.mjs",
);
const MARKER = "SECRET_FIXTURE_MARKER_5b1d";

// Node の型の除去（install なしで .ts を import する）が使える環境だけ。CI の Node 22.18 以降は使える。
const stripsTypes = Boolean(
  (process.features as { typescript?: unknown }).typescript,
);

function run(args: string[]) {
  return spawnSync(process.execPath, [scriptFile, ...args], {
    encoding: "utf8",
    cwd: repoRoot,
  });
}

let temp: ReturnType<typeof makeTempDir>;
beforeEach(() => {
  temp = makeTempDir();
});
afterEach(() => temp.cleanup());

describe("同梱の写し（B1）", () => {
  it("repo に置いてあり、main の読み込みと同じ検証（parseSnapshot）を通る", () => {
    expect(existsSync(bundledFile)).toBe(true);
    const text = readFileSync(bundledFile, "utf8");
    const parsed = parseSnapshot(text, SNAPSHOT_POLICY, { nowMs: Date.now() });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.source).toBe("grimodex");
    // 検証で 1 件も捨てられていない（生成物がそのまま採用される）。
    expect(parsed.findings).toEqual([]);
    const keys = Object.keys(parsed.snapshot.models);
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      expect(SNAPSHOT_PROVIDERS as readonly string[]).toContain(
        key.slice(0, key.indexOf("/")),
      );
    }
  });

  it("store の loadBundled がそのまま読める（dev の path の解決も一致する）", () => {
    const resolved = resolveBundledSnapshotPath({
      isPackaged: false,
      resourcesPath: "/ignored",
      mainDir: path.join(repoRoot, "dist-electron"),
    });
    expect(path.resolve(resolved)).toBe(path.resolve(bundledFile));
    const store = createModelCapabilityStore({
      cacheDir: temp.dir,
      bundledPath: resolved,
    });
    expect(store.loadBundled(Date.now()).ok).toBe(true);
  });

  it("生成 script の出力の path と、app の配信 URL の path は同じ", () => {
    const source = readFileSync(scriptFile, "utf8");
    const match = /SNAPSHOT_REPO_PATH\s*=\s*"([^"]+)"/u.exec(source);
    expect(match?.[1]).toBe(MODEL_CAPABILITY_SNAPSHOT_REPO_PATH);
  });

  it("prettier の対象外（1 model 1 行の書式を script が保つ）", () => {
    const ignore = readFileSync(path.join(repoRoot, ".prettierignore"), "utf8");
    expect(ignore.split("\n")).toContain(MODEL_CAPABILITY_SNAPSHOT_REPO_PATH);
  });

  it.skipIf(!stripsTypes)(
    "script の check が通る（書式が generate の出力と 1 byte も違わない）",
    () => {
      const result = run(["check"]);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/^ok /u);
    },
  );
});

/** models.dev の応答の形（読む field だけ）。文字列の field は読まれないことの確認に marker を入れる。 */
function modelsDevFixture(): string {
  const model = (context: number, output: number) => ({
    name: MARKER,
    type: "chat",
    tool_call: true,
    reasoning: false,
    limit: { context, output },
  });
  return JSON.stringify({
    openai: {
      name: MARKER,
      api: `https://${MARKER}.example/`,
      models: {
        "gpt-a": model(128_000, 16_384),
        "gpt-b": model(1_000_000, 32_768),
        embed: { type: "embedding", limit: { context: 8_000, output: 0 } },
      },
    },
    anthropic: { models: { "claude-a": model(200_000, 64_000) } },
    "unmapped-provider": { models: { x: model(1, 1) } },
  });
}

describe.skipIf(!stripsTypes)("生成 script（通信しない）", () => {
  const GENERATED_AT = "2026-11-18T15:28:51Z";

  it("generate は models.dev の応答から、検証を通る決定的な写しを書く", () => {
    const input = path.join(temp.dir, "api.json");
    writeFileSync(input, modelsDevFixture(), "utf8");
    const out1 = path.join(temp.dir, "out1", "snapshot.json");
    const out2 = path.join(temp.dir, "out2", "snapshot.json");
    for (const out of [out1, out2]) {
      const result = run([
        "generate",
        input,
        "--generated-at",
        GENERATED_AT,
        "--out",
        out,
      ]);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("models=3");
      expect(result.stdout).not.toContain(MARKER);
    }
    const text = readFileSync(out1, "utf8");
    expect(text).toBe(readFileSync(out2, "utf8"));
    const parsed = parseSnapshot(text, SNAPSHOT_POLICY, { nowMs: Date.now() });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.snapshot.source).toBe("grimodex");
    expect(parsed.snapshot.generatedAt).toBe(GENERATED_AT);
    expect(Object.keys(parsed.snapshot.models)).toEqual([
      "anthropic/claude-a",
      "openai/gpt-a",
      "openai/gpt-b",
    ]);
    // 文字列の field・対象外の provider・chat 以外は写しに入らない。
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain("unmapped");
    expect(text).not.toContain("embed");
    // 1 model 1 行。
    expect(
      text.split("\n").filter((line) => line.includes('"openai/')),
    ).toHaveLength(2);
    // 生成した file は check を通る。
    const check = run(["check", out1]);
    expect(check.status).toBe(0);
  });

  it("入力が壊れている・変換できないときは、非 0 で終わり、出力 file に触れない", () => {
    const out = path.join(temp.dir, "snapshot.json");
    writeFileSync(out, "KEEP", "utf8");
    const broken = path.join(temp.dir, "broken.json");
    writeFileSync(broken, `{"openai": ${MARKER}`, "utf8");
    const result = run([
      "generate",
      broken,
      "--generated-at",
      GENERATED_AT,
      "--out",
      out,
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/syntax/u);
    expect(result.stderr).not.toContain(MARKER);

    const empty = path.join(temp.dir, "empty.json");
    writeFileSync(
      empty,
      JSON.stringify({ "unmapped-provider": { models: {} } }),
      "utf8",
    );
    const second = run([
      "generate",
      empty,
      "--generated-at",
      GENERATED_AT,
      "--out",
      out,
    ]);
    expect(second.status).toBe(1);
    expect(readFileSync(out, "utf8")).toBe("KEEP");
  });

  it("--generated-at が無い・不正なら失敗する", () => {
    const input = path.join(temp.dir, "api.json");
    writeFileSync(input, modelsDevFixture(), "utf8");
    const out = path.join(temp.dir, "snapshot.json");
    expect(run(["generate", input, "--out", out]).status).toBe(1);
    expect(
      run(["generate", input, "--generated-at", "yesterday", "--out", out])
        .status,
    ).toBe(1);
    expect(existsSync(out)).toBe(false);
  });

  it("check は、書式が違う file・source が違う file・捨てられる項目がある file を拒否する", () => {
    const input = path.join(temp.dir, "api.json");
    writeFileSync(input, modelsDevFixture(), "utf8");
    const good = path.join(temp.dir, "good.json");
    expect(
      run(["generate", input, "--generated-at", GENERATED_AT, "--out", good])
        .status,
    ).toBe(0);
    const text = readFileSync(good, "utf8");

    const reformatted = path.join(temp.dir, "reformatted.json");
    writeFileSync(reformatted, JSON.stringify(JSON.parse(text)), "utf8");
    const a = run(["check", reformatted]);
    expect(a.status).toBe(1);
    expect(a.stderr).toMatch(/書式/u);

    const foreign = path.join(temp.dir, "foreign.json");
    writeFileSync(foreign, text.replace('"grimodex"', '"models.dev"'), "utf8");
    const b = run(["check", foreign]);
    expect(b.status).toBe(1);
    expect(b.stderr).toMatch(/source/u);

    const extra = path.join(temp.dir, "extra.json");
    writeFileSync(
      extra,
      text.replace('"reasoning":false', '"reasoning":false,"note":"x"'),
      "utf8",
    );
    const c = run(["check", extra]);
    expect(c.status).toBe(1);
  });
});
