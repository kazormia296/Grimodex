/**
 * scripts/generate-model-capability-snapshot.mjs の compare mode（定期 workflow の判断）の試験。
 * 通信しない。fixture の写しだけを使う。generate／check は electron/main/modelCapabilityBundled.test.ts が見る。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CANDIDATE_FILE_NAME,
  DRAFT_REASONS,
  REVIEW_POLICY,
  evaluateUpdate,
  formatSnapshotFile,
  readCandidateFromDir,
  renderPrBody,
  renderPrTitle,
  renderSummary,
} from "./generate-model-capability-snapshot.mjs";

const scriptFile = fileURLToPath(
  new URL("./generate-model-capability-snapshot.mjs", import.meta.url),
);
const NOW = Date.parse("2026-11-19T12:00:00Z");
const BASE_AT = "2026-11-18T00:00:00Z";
const CANDIDATE_AT = "2026-11-19T11:59:00Z";

function models(count, provider = "openai", offset = 0, overrides = {}) {
  const result = {};
  for (let i = 0; i < count; i += 1) {
    result[`${provider}/model-${offset + i}`] = {
      contextWindow: 100_000 + i,
      maxOutputTokens: 8_192,
      toolCall: true,
      reasoning: i % 2 === 0,
      ...(overrides[i] ?? {}),
    };
  }
  return result;
}

function snapshotText(modelMap, generatedAt, source = "grimodex") {
  return formatSnapshotFile({
    schemaVersion: 1,
    generatedAt,
    source,
    models: modelMap,
  });
}

function evaluate(baseModels, candidateModels, overrides = {}) {
  return evaluateUpdate({
    baseText: snapshotText(baseModels, overrides.baseAt ?? BASE_AT),
    candidateText:
      overrides.candidateText ??
      snapshotText(candidateModels, overrides.candidateAt ?? CANDIDATE_AT),
    nowMs: overrides.nowMs ?? NOW,
  });
}

/** 先頭の count 件の contextWindow を 5 倍にした model 群。 */
function withContextTimesFive(base, count) {
  const result = { ...base };
  for (const key of Object.keys(base).slice(0, count)) {
    result[key] = { ...base[key], contextWindow: base[key].contextWindow * 5 };
  }
  return result;
}

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "grimodex-caps-compare-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("evaluateUpdate（定期 workflow の判断）", () => {
  it("generatedAt だけが違う写しは unchanged で、PR を作らない", () => {
    const base = models(30);
    const report = evaluate(base, base);
    assert.equal(report.status, "unchanged");
    assert.equal(report.draft, false);
    assert.deepEqual(report.draftReasons, []);
    assert.deepEqual(report.counts, {
      base: 30,
      candidate: 30,
      added: 0,
      removed: 0,
      changed: 0,
    });
  });

  it("小さな追加・変更は draft にならず、件数を数える", () => {
    const base = models(100);
    const next = {
      ...base,
      ...models(3, "openai", 1_000),
      "openai/model-5": { ...base["openai/model-5"], maxOutputTokens: 16_384 },
    };
    const report = evaluate(base, next);
    assert.equal(report.status, "changed");
    assert.equal(report.draft, false);
    assert.deepEqual(report.counts, {
      base: 100,
      candidate: 103,
      added: 3,
      removed: 0,
      changed: 1,
    });
    assert.deepEqual(
      report.providers.map((row) => [row.provider, row.base, row.candidate]),
      [
        ["anthropic", 0, 0],
        ["openai", 100, 103],
        ["openrouter", 0, 0],
        ["sakana", 0, 0],
      ],
    );
  });

  it("件数が急減したら拒否ではなく draft（shrunk）で、失敗の findings を載せる", () => {
    const base = { ...models(40, "openai"), ...models(10, "anthropic") };
    const next = models(20, "openai");
    const report = evaluate(base, next);
    assert.equal(report.status, "changed");
    assert.equal(report.draft, true);
    assert.ok(report.draftReasons.includes("shrunk"));
    assert.ok(report.findings.some((f) => f.code === "model-count-dropped"));
    const body = renderPrBody(report);
    assert.match(body, /\*\*draft\*\*/);
    assert.match(
      body,
      /配布済みの app は、同梱の写しとの比較でこの写しを拒否します/,
    );
    assert.match(body, /model の件数の急減: 50 → 20/);
  });

  it("provider が丸ごと無くなったら draft（provider-removed）", () => {
    const base = { ...models(30, "openai"), ...models(4, "sakana") };
    const report = evaluate(base, models(30, "openai"));
    assert.equal(report.status, "changed");
    assert.deepEqual(report.draftReasons, ["provider-removed"]);
    assert.match(
      renderPrBody(report),
      /`sakana` が丸ごと無くなった（前回 4 件）/,
    );
  });

  it("検出の件数は閾値ちょうどでは draft にならず、超えたら many-attention-findings", () => {
    const base = models(200);
    const atLimit = evaluate(
      base,
      withContextTimesFive(base, REVIEW_POLICY.maxAttentionFindings),
    );
    assert.equal(atLimit.status, "changed");
    assert.equal(atLimit.attentionTotal, REVIEW_POLICY.maxAttentionFindings);
    assert.equal(atLimit.draft, false);
    const over = evaluate(
      base,
      withContextTimesFive(base, REVIEW_POLICY.maxAttentionFindings + 1),
    );
    assert.equal(over.attentionTotal, REVIEW_POLICY.maxAttentionFindings + 1);
    assert.deepEqual(over.draftReasons, ["many-attention-findings"]);
  });

  it("切られた検出（findings-truncated）も件数に数える", () => {
    const base = models(400);
    const report = evaluate(base, withContextTimesFive(base, 150));
    // maxFindings で切られても、合計は 150。
    assert.equal(report.attentionTotal, 150);
    assert.ok(report.findings.some((f) => f.code === "findings-truncated"));
    assert.ok(report.draftReasons.includes("many-attention-findings"));
  });

  it("追加・削除・変更の合計が前回の割合を超えたら high-churn", () => {
    const base = models(100);
    const limit = Math.floor(100 * REVIEW_POLICY.maxChurnRatio);
    const atLimit = evaluate(base, {
      ...base,
      ...models(limit, "openai", 1_000),
    });
    assert.equal(atLimit.draft, false);
    const over = evaluate(base, {
      ...base,
      ...models(limit + 1, "openai", 1_000),
    });
    assert.deepEqual(over.draftReasons, ["high-churn"]);
  });

  it("古い候補・同時刻で中身が違う候補は拒否（PR を作らない）", () => {
    const base = models(30);
    const stale = evaluate(
      base,
      { ...base, ...models(1, "openai", 99) },
      {
        candidateAt: "2026-11-17T00:00:00Z",
      },
    );
    assert.equal(stale.status, "rejected");
    assert.equal(stale.rejectCode, "stale");
    const conflict = evaluate(
      base,
      { ...base, ...models(1, "openai", 99) },
      {
        candidateAt: BASE_AT,
      },
    );
    assert.equal(conflict.status, "rejected");
    assert.equal(conflict.rejectCode, "generated-at-conflict");
  });

  it("候補を検証し直す：source・書式・未来の時刻・壊れた JSON は例外", () => {
    const base = models(30);
    const next = { ...base, ...models(2, "openai", 99) };
    assert.throws(
      () =>
        evaluate(base, next, {
          candidateText: snapshotText(next, CANDIDATE_AT, "models.dev"),
        }),
      /source/,
    );
    assert.throws(
      () =>
        evaluate(base, next, {
          candidateText: JSON.stringify(
            JSON.parse(snapshotText(next, CANDIDATE_AT)),
          ),
        }),
      /書式/,
    );
    assert.throws(
      () => evaluate(base, next, { candidateText: "{" }),
      /検証に失敗/,
    );
    // CI の時計から 5 分より先の時刻は、実行時の許容（1 日）の内側でも拒否する。
    assert.throws(
      () => evaluate(base, next, { candidateAt: "2026-11-19T12:10:00Z" }),
      /未来/,
    );
    assert.doesNotThrow(() =>
      evaluate(base, next, { candidateAt: "2026-11-19T12:04:00Z" }),
    );
  });

  it("master の写しが 30 日を超えて古いと baseStale（T10）で、summary に警告を出す", () => {
    const base = models(30);
    const next = { ...base, ...models(1, "openai", 99) };
    const fresh = evaluate(base, next);
    assert.equal(fresh.baseStale, false);
    assert.doesNotMatch(renderSummary(fresh), /警告/);
    const old = evaluate(base, next, { baseAt: "2026-10-01T00:00:00Z" });
    assert.equal(old.baseAgeDays, 49);
    assert.equal(old.baseStale, true);
    assert.match(renderSummary(old), /警告.*49 日経っています/);
    const exactly = evaluate(base, next, { baseAt: "2026-10-20T12:00:00Z" });
    assert.equal(exactly.baseAgeDays, 30);
    assert.equal(exactly.baseStale, false);
  });
});

describe("PR の本文（upstream の文字列を展開しない）", () => {
  it("title は検証済みの日付だけから作る", () => {
    const report = evaluate(models(30), {
      ...models(30),
      ...models(1, "openai", 99),
    });
    assert.equal(
      renderPrTitle(report),
      "chore(chat): モデル能力の写しを更新する (2026-11-19)\n",
    );
    assert.equal(
      renderPrTitle({ ...report, candidateGeneratedAt: "x`;rm -rf" }),
      "chore(chat): モデル能力の写しを更新する (?)\n",
    );
  });

  it("key は検証を通ったものだけを code span で出し、それ以外は省略する", () => {
    const report = {
      ...evaluate(models(30), { ...models(30), ...models(1, "openai", 99) }),
      draft: true,
      draftReasons: ["provider-removed", "<script>alert(1)</script>"],
      findings: [
        { code: "context-changed", key: "openai/<script>", from: 1, to: 2 },
        { code: "provider-removed", key: "@everyone", from: 3 },
        { code: "context-changed", key: "openrouter/~a/b", from: 10, to: 40 },
        {
          code: "capability-changed",
          key: "openai/model-1",
          field: "reasoning\n# h",
          from: true,
          to: false,
        },
        {
          code: "capability-changed",
          key: "openai/model-2",
          field: "toolCall",
          from: true,
          to: false,
        },
        {
          code: "context-changed",
          key: "openai/model-3",
          from: "<b>",
          to: 1e300,
        },
        { code: "unknown-code", key: "openai/model-4" },
      ],
    };
    const body = renderPrBody(report);
    assert.doesNotMatch(body, /<script>|@everyone|alert|<b>|# h|unknown-code/);
    assert.match(body, /`openrouter\/~a\/b` の contextWindow: 10 → 40/);
    assert.match(body, /`openai\/model-2` の toolCall: true → false/);
    assert.match(body, /（key を省略）/);
    // draft の理由は列挙したものだけ。
    assert.match(body, /前回にあった provider が丸ごと無くなりました/);
    assert.doesNotMatch(body, /undefined/);
  });

  it("本文は draft でない PR に「確認が要る点」を出さない", () => {
    const report = evaluate(models(100), {
      ...models(100),
      ...models(1, "openai", 1_000),
    });
    assert.equal(report.draft, false);
    assert.doesNotMatch(renderPrBody(report), /確認が要る点/);
  });

  it("draft の理由は列挙した集合に限る", () => {
    assert.deepEqual(
      [...DRAFT_REASONS],
      ["shrunk", "provider-removed", "many-attention-findings", "high-churn"],
    );
  });
});

describe("readCandidateFromDir（artifact の取り込み）", () => {
  it("候補の写し 1 file だけを受け入れる", () => {
    const temp = tempDir();
    try {
      writeFileSync(path.join(temp.dir, CANDIDATE_FILE_NAME), "{}\n");
      assert.equal(readCandidateFromDir(temp.dir), "{}\n");
    } finally {
      temp.cleanup();
    }
  });

  it(
    "余分な file・別の名前・空の directory・symlink を拒否する",
    {
      // symlink の作成に権限が要る環境（Windows）では飛ばす。CI は Linux だけで走る。
      skip: process.platform === "win32",
    },
    () => {
      const extra = tempDir();
      const renamed = tempDir();
      const empty = tempDir();
      const linked = tempDir();
      const outside = tempDir();
      try {
        writeFileSync(path.join(extra.dir, CANDIDATE_FILE_NAME), "{}\n");
        writeFileSync(path.join(extra.dir, "run.mjs"), "process.exit(0)\n");
        assert.throws(() => readCandidateFromDir(extra.dir), /1 file だけ/);
        writeFileSync(path.join(renamed.dir, "other.json"), "{}\n");
        assert.throws(() => readCandidateFromDir(renamed.dir), /1 file だけ/);
        assert.throws(() => readCandidateFromDir(empty.dir), /1 file だけ/);
        // 通常の file に見える中身でも、symlink なら読まない（target は directory の外の temp）。
        writeFileSync(path.join(outside.dir, "target.json"), "{}\n");
        symlinkSync(
          path.join(outside.dir, "target.json"),
          path.join(linked.dir, CANDIDATE_FILE_NAME),
        );
        assert.throws(() => readCandidateFromDir(linked.dir), /通常の file/);
      } finally {
        for (const temp of [extra, renamed, empty, linked, outside]) {
          temp.cleanup();
        }
      }
    },
  );
});

describe("compare の CLI", () => {
  function iso(ms) {
    return new Date(ms).toISOString().replace(/\.\d+Z$/, "Z");
  }
  function setup({ baseAgeDays = 2, next }) {
    const temp = tempDir();
    const base = models(100);
    const nowMs = Date.now();
    const baseFile = path.join(temp.dir, "base.json");
    writeFileSync(
      baseFile,
      snapshotText(base, iso(nowMs - baseAgeDays * 86_400_000)),
    );
    const candidateDir = path.join(temp.dir, "candidate");
    mkdirSync(candidateDir);
    writeFileSync(
      path.join(candidateDir, CANDIDATE_FILE_NAME),
      snapshotText(
        next ?? { ...base, ...models(2, "openai", 1_000) },
        iso(nowMs - 60_000),
      ),
    );
    return { temp, baseFile, candidateDir, base };
  }
  function run(args) {
    return spawnSync(process.execPath, [scriptFile, ...args], {
      encoding: "utf8",
    });
  }

  it("変更があれば、真偽 2 つだけを github-output に、title と本文を file に書く", () => {
    const { temp, baseFile, candidateDir } = setup({});
    try {
      const out = path.join(temp.dir, "out.txt");
      const summary = path.join(temp.dir, "summary.md");
      const result = run([
        "compare",
        "--base",
        baseFile,
        "--candidate-dir",
        candidateDir,
        "--github-output",
        out,
        "--summary",
        summary,
        "--pr-title",
        path.join(temp.dir, "title.txt"),
        "--pr-body",
        path.join(temp.dir, "body.md"),
        "--report",
        path.join(temp.dir, "report.json"),
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(out, "utf8"), "changed=true\ndraft=false\n");
      assert.match(readFileSync(summary, "utf8"), /判定: changed/);
      assert.match(
        readFileSync(path.join(temp.dir, "title.txt"), "utf8"),
        /^chore\(chat\): モデル能力の写しを更新する \(\d{4}-\d{2}-\d{2}\)\n$/,
      );
      assert.match(
        readFileSync(path.join(temp.dir, "body.md"), "utf8"),
        /追加 \| 2/,
      );
      const report = JSON.parse(
        readFileSync(path.join(temp.dir, "report.json"), "utf8"),
      );
      assert.equal(report.counts.added, 2);
      assert.equal(report.status, "changed");
    } finally {
      temp.cleanup();
    }
  });

  it("差分が無ければ changed=false で、PR の title と本文を書かない", () => {
    const { temp, baseFile, candidateDir, base } = setup({});
    try {
      writeFileSync(
        path.join(candidateDir, CANDIDATE_FILE_NAME),
        snapshotText(
          base,
          new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, "Z"),
        ),
      );
      const out = path.join(temp.dir, "out.txt");
      const result = run([
        "compare",
        "--base",
        baseFile,
        "--candidate-dir",
        candidateDir,
        "--github-output",
        out,
        "--pr-body",
        path.join(temp.dir, "body.md"),
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(out, "utf8"), "changed=false\ndraft=false\n");
      assert.equal(existsSync(path.join(temp.dir, "body.md")), false);
    } finally {
      temp.cleanup();
    }
  });

  it("拒否した候補は非 0 で終わり、github-output を書かず、summary に理由を残す", () => {
    const { temp, baseFile, candidateDir, base } = setup({});
    try {
      writeFileSync(
        path.join(candidateDir, CANDIDATE_FILE_NAME),
        snapshotText(
          { ...base, ...models(2, "openai", 1_000) },
          "2026-01-01T00:00:00Z",
        ),
      );
      const out = path.join(temp.dir, "out.txt");
      const summary = path.join(temp.dir, "summary.md");
      const result = run([
        "compare",
        "--base",
        baseFile,
        "--candidate-dir",
        candidateDir,
        "--github-output",
        out,
        "--summary",
        summary,
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /拒否しました: stale/);
      assert.equal(existsSync(out), false);
      assert.match(readFileSync(summary, "utf8"), /rejected（stale）/);
    } finally {
      temp.cleanup();
    }
  });

  it("master の写しが古いと GitHub の警告を出す（T10）", () => {
    const { temp, baseFile, candidateDir } = setup({ baseAgeDays: 40 });
    try {
      const summary = path.join(temp.dir, "summary.md");
      const result = run([
        "compare",
        "--base",
        baseFile,
        "--candidate-dir",
        candidateDir,
        "--summary",
        summary,
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^::warning title=.*40 日経っています/m);
      assert.match(readFileSync(summary, "utf8"), /警告/);
    } finally {
      temp.cleanup();
    }
  });

  it("引数の誤りは非 0（candidate と candidate-dir の両方・どちらも無し）", () => {
    const { temp, baseFile, candidateDir } = setup({});
    try {
      const file = path.join(candidateDir, CANDIDATE_FILE_NAME);
      assert.notEqual(
        run([
          "compare",
          "--base",
          baseFile,
          "--candidate",
          file,
          "--candidate-dir",
          candidateDir,
        ]).status,
        0,
      );
      assert.notEqual(run(["compare", "--base", baseFile]).status, 0);
      assert.notEqual(run(["compare", "--candidate", file]).status, 0);
    } finally {
      temp.cleanup();
    }
  });

  it("余分な file のある artifact の directory は拒否する", () => {
    const { temp, baseFile, candidateDir } = setup({});
    try {
      writeFileSync(path.join(candidateDir, "evil.mjs"), "process.exit(0)\n");
      const result = run([
        "compare",
        "--base",
        baseFile,
        "--candidate-dir",
        candidateDir,
      ]);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /1 file だけ/);
    } finally {
      temp.cleanup();
    }
  });
});
