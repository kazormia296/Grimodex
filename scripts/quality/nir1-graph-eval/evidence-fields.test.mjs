// Prereg v3 (the four evidence items): how node makes the receipt fields
// (hashes, never the text), and the rule that refuses plain text (§4, Q6).
// Synthetic values only; the plain texts below are made up for the test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";
import {
  evidenceFieldErrors,
  hashFetchEvidence,
  hashGraphEvidence,
  hashRevisionRead,
  hashRowTexts,
  plaintextErrors,
  plaintextNeedlesOf,
  sha256Text,
} from "./evidence-fields.mjs";
import { hashObservationPaths } from "./material-revision.mjs";
import { textSha256 } from "./quality-evidence-items.mjs";

const QUOTE = "Mira keeps the brass bowl.";
const EXCERPT =
  "Mira folded the blue cloth into a square 𠮷 beneath the brass bowl.";
const raw = () => ({
  graphOnly: {
    sceneId: "u-s1",
    hop: 1,
    pinEntityId: "e-mira",
    canonicalRange: { start: 0, end: EXCERPT.length },
    excerpt: EXCERPT,
    edges: [
      {
        from: { entityId: "e-orin" },
        to: { entityId: "e-mira" },
        evidence: [{ evidenceId: "ev-1", quote: QUOTE }],
      },
    ],
  },
  pathAttachments: [
    {
      sceneId: "u-s2",
      hop: 2,
      edges: [
        {
          from: { entityId: "e-a" },
          to: { entityId: "e-b" },
          evidence: [{ evidenceId: "ev-2", quote: "B is here" }],
        },
      ],
    },
  ],
});

test("v3 §4: hash はノードが作り、verdict と同じ関数（UTF-8 の sha256）。範囲の長さは UTF-16（astral 文字は 2）", () => {
  for (const text of ["", "abc", EXCERPT, "𠮷", "日本語の本文"])
    assert.equal(sha256Text(text), textSha256(text), text);
  const hashed = hashGraphEvidence(raw());
  assert.equal(hashed.graphOnly.excerptSha256, sha256Text(EXCERPT));
  assert.equal(hashed.graphOnly.excerptUtf16Length, EXCERPT.length);
  assert.equal(EXCERPT.length, [...EXCERPT].length + 1);
  assert.deepEqual(hashed.graphOnly.edges[0], {
    from: "e-orin",
    to: "e-mira",
    evidence: [{ evidenceId: "ev-1", quoteSha256: sha256Text(QUOTE) }],
  });
  assert.deepEqual(hashed.pathAttachments[0].sceneId, "u-s2");
  assert.equal(hashed.pathAttachments[0].hop, 2);
  // Nothing in clear survives.
  const json = JSON.stringify(hashed);
  for (const text of [QUOTE, EXCERPT, "B is here"])
    assert.ok(!json.includes(text), text);
  assert.equal(hashGraphEvidence(null), null);
  assert.equal(
    hashGraphEvidence({ graphOnly: null, pathAttachments: [] }).graphOnly,
    null,
  );
});

test("v3 §2.3: rowTexts は kind と hash と UTF-16 長の行になり、本文は残らない", () => {
  const rows = hashRowTexts([
    { sceneId: "u-a", kind: "raw", text: "chunk of a" },
    { sceneId: "u-a", kind: "ir", text: "excerpt 𠮷" },
    { sceneId: "u-b", kind: "graph-only", text: EXCERPT },
  ]);
  assert.deepEqual(rows[1], {
    sceneId: "u-a",
    kind: "ir",
    excerptSha256: sha256Text("excerpt 𠮷"),
    excerptUtf16Length: "excerpt 𠮷".length,
  });
  assert.ok(!JSON.stringify(rows).includes("chunk of a"));
  assert.equal(hashRowTexts(null), null);
});

test("v3 §2.1: Revision の読みは quote を hash にして範囲を残す。読めない Revision は固定の語で unavailable（エラー文を残さない）", () => {
  const read = {
    ok: true,
    value: {
      status: "available",
      result: {
        entities: [
          {
            evidence: [
              {
                evidenceId: "ev-1",
                sourceRef: "codex:e-orin",
                quote: "Orin is a courier.",
                startUtf16: 0,
                endUtf16: 18,
              },
              {
                evidenceId: "ev-2",
                sourceRef: "a sourceRef with spaces",
                quote: "x",
                startUtf16: 0,
                endUtf16: 1,
              },
            ],
          },
        ],
      },
    },
  };
  const row = hashRevisionRead({
    logicalRevisionId: "r1",
    runtimeRevisionId: "rt-r1",
    read,
  });
  assert.deepEqual(row.evidence[0], {
    evidenceId: "ev-1",
    sourceRef: "codex:e-orin",
    startUtf16: 0,
    endUtf16: 18,
    quoteSha256: sha256Text("Orin is a courier."),
  });
  assert.equal(row.evidence[1].sourceRef, "unrepresentable");
  assert.ok(!JSON.stringify(row).includes("courier"));
  const unavailable = hashRevisionRead({
    logicalRevisionId: "r1",
    runtimeRevisionId: "rt-r1",
    read: {
      ok: true,
      value: { status: "unavailable", result: { reason: "x y z" } },
    },
  });
  assert.equal(unavailable.unavailable, "unavailable");
  assert.equal(unavailable.evidence, undefined);
  const failed = hashRevisionRead({
    logicalRevisionId: "r1",
    runtimeRevisionId: "rt-r1",
    read: { ok: false, error: "a long error message with text" },
  });
  assert.equal(failed.unavailable, "read-failed");
  assert.ok(!JSON.stringify(failed).includes("error message"));
});

test("hashObservationPaths: k64 の probe の fetch は evidenceRaw・rowTexts を evidence・rowExcerpts にして平文を捨てる。trace の probe の fetch（その field が無い）は変わらない", () => {
  const observation = {
    fetches: [
      {
        seq: 1,
        paths: { graphOnly: null, pathAttachments: [] },
        evidenceRaw: raw(),
        rowTexts: [{ sceneId: "u-a", kind: "raw", text: "chunk of a" }],
      },
      { seq: 2, paths: null, evidenceRaw: null, rowTexts: [] },
    ],
  };
  const hashed = hashObservationPaths(observation);
  assert.equal(hashed.fetches[0].evidenceRaw, undefined);
  assert.equal(hashed.fetches[0].rowTexts, undefined);
  assert.equal(hashed.fetches[0].evidence.graphOnly.sceneId, "u-s1");
  assert.equal(hashed.fetches[0].rowExcerpts[0].excerptUtf16Length, 10);
  assert.equal(hashed.fetches[1].evidence, null);
  assert.deepEqual(hashed.fetches[1].rowExcerpts, []);
  const json = JSON.stringify(hashed);
  for (const text of [QUOTE, EXCERPT, "chunk of a"])
    assert.ok(!json.includes(text), text);
  // A trace fetch has neither field: returned as it is.
  const trace = { seq: 1, paths: null, result: { status: "completed" } };
  assert.deepEqual(hashFetchEvidence(trace), trace);
  assert.deepEqual(hashObservationPaths({ fetches: [trace] }).fetches[0], {
    ...trace,
  });
});

/** A receipt fragment with every new field in its allowed shape (incl. null, enum, boolean). */
function goodReceipt() {
  const evidence = hashGraphEvidence(raw());
  return {
    evidenceObservation: {
      readAfterSamples: true,
      samplesBeforeRead: 69,
      typedRevisions: [
        {
          logicalRevisionId: "r1",
          runtimeRevisionId: "rt-r1",
          evidence: [
            {
              evidenceId: "ev-1",
              sourceRef: "codex:e-orin",
              startUtf16: 0,
              endUtf16: 18,
              quoteSha256: sha256Text("Orin is a courier."),
            },
          ],
        },
        {
          logicalRevisionId: "r2",
          runtimeRevisionId: "rt-r2",
          unavailable: "read-failed",
        },
      ],
    },
    samples: [
      {
        followUp: {
          parent: {
            evidence: null,
            rowExcerpts: hashRowTexts([
              { sceneId: "u-a", kind: "raw", text: "t" },
            ]),
          },
          child: {
            evidence,
            rowExcerpts: hashRowTexts([
              { sceneId: "u-a", kind: "raw", text: "t" },
              { sceneId: "u-s1", kind: "graph-only", text: EXCERPT },
            ]),
          },
        },
      },
    ],
  };
}

test("v3 §4 (i): 新 field は整数・64 桁の hex・ID・固定の語・真偽値・null だけ。v3 自身の値（excerptSha256・quoteSha256・rowExcerpts・kind の語・null）は拒否しない", () => {
  assert.deepEqual(evidenceFieldErrors(goodReceipt()), []);
  // An older receipt (no new field) is not an error here: the verdict holds.
  assert.deepEqual(
    evidenceFieldErrors({ samples: [{ followUp: { parent: {}, child: {} } }] }),
    [],
  );
  // null values of leaves are allowed (a value the verdict holds on).
  const withNull = goodReceipt();
  withNull.samples[0].followUp.child.evidence.graphOnly.pinEntityId = null;
  assert.deepEqual(evidenceFieldErrors(withNull), []);
});

test("v3 §4 (i): 禁止の key（quote・excerpt・body・text・summary）、規定外の key、平文の値、hash でない値、語彙の外の kind は拒否する（新 field の中。key は完全一致で見る）", () => {
  const bad = (mutate, pattern) => {
    const receipt = goodReceipt();
    mutate(receipt);
    const errors = evidenceFieldErrors(receipt);
    assert.ok(errors.length > 0, String(pattern));
    assert.match(errors.join("\n"), pattern);
  };
  const child = (receipt) => receipt.samples[0].followUp.child;
  for (const key of ["quote", "excerpt", "body", "text", "summary"]) {
    bad(
      (r) => {
        child(r).evidence.graphOnly[key] = "Mira keeps the brass bowl.";
      },
      new RegExp(`graphOnly\\.${key} is not a field`, "u"),
    );
    bad(
      (r) => {
        child(r).rowExcerpts[0][key] = "chunk";
      },
      new RegExp(`rowExcerpts\\[0\\]\\.${key} is not a field`, "u"),
    );
  }
  // An Evidence row with its quote in clear (the wire shape).
  bad((r) => {
    child(r).evidence.graphOnly.edges[0].evidence[0].quote = QUOTE;
  }, /evidence\[0\]\.quote is not a field/u);
  // A plain text where an ID or a hash goes.
  bad((r) => {
    child(r).evidence.graphOnly.pinEntityId = "Mira keeps the brass bowl.";
  }, /pinEntityId does not have the shape/u);
  bad((r) => {
    child(r).evidence.graphOnly.excerptSha256 = "Mira folded the blue cloth";
  }, /excerptSha256 does not have the shape/u);
  bad((r) => {
    child(r).evidence.graphOnly.excerptSha256 = "A".repeat(64);
  }, /excerptSha256/u);
  bad((r) => {
    child(r).rowExcerpts[0].kind = "a chunk of the scene";
  }, /kind does not have the shape/u);
  bad((r) => {
    child(r).rowExcerpts[0].excerptUtf16Length = "10";
  }, /excerptUtf16Length/u);
  bad((r) => {
    r.evidenceObservation.readAfterSamples = "yes";
  }, /readAfterSamples/u);
  bad((r) => {
    r.evidenceObservation.typedRevisions[1].unavailable = "the Native said no";
  }, /unavailable does not have the shape/u);
  bad((r) => {
    r.evidenceObservation.typedRevisions[0].evidence[0].quote = QUOTE;
  }, /quote is not a field/u);
});

test("v3 §4 (ii)(iii): fixture の Scene の本文・sceneExcerpt.body・Entity の summary が受領書のどこかの文字列（key を含む）に部分文字列で現れたら拒否する。Evidence の JSON の形も拒否する", () => {
  const needles = [
    "Mira folded the blue cloth into a square",
    "Orin is a courier.",
  ];
  const clean = goodReceipt();
  assert.deepEqual(plaintextErrors(clean, needles), []);
  const inNew = goodReceipt();
  inNew.samples[0].followUp.child.rowExcerpts[0].sceneId =
    "see: Mira folded the blue cloth into a square";
  assert.match(
    plaintextErrors(inNew, needles).join(),
    /fixture text in clear/u,
  );
  // An existing field, not only the new ones.
  const inOld = {
    ...goodReceipt(),
    settings: { note: "run for Orin is a courier. today" },
  };
  assert.match(
    plaintextErrors(inOld, needles).join(),
    /settings\.note contains a fixture text/u,
  );
  // A key that is a text.
  const inKey = { ...goodReceipt(), map: { "Orin is a courier.": 1 } };
  assert.match(plaintextErrors(inKey, needles).join(), /\(a key\)/u);
  // An Evidence JSON.
  const evidenceJson = {
    ...goodReceipt(),
    leaked: [{ evidenceId: "ev-1", quote: "x" }],
  };
  assert.match(
    plaintextErrors(evidenceJson, needles).join(),
    /Evidence record with its quote in clear/u,
  );
  // The scan cannot be skipped by having no texts to look for.
  assert.match(plaintextErrors(clean, [])[0], /\[precheck\]/u);
  assert.match(plaintextErrors(clean, undefined)[0], /\[precheck\]/u);
});

test("v3 §4 (ii): 凍結の fixture（G-01〜G-08 の 13 variant の 9 file）から走査する本文が取れ、label と relation の型の語は含めない", () => {
  const root = new URL("../../../", import.meta.url);
  const read = (relative) =>
    JSON.parse(readFileSync(new URL(relative, root), "utf8"));
  for (const relative of [
    "evals/nir1-g01/fixture.v1.json",
    "evals/nir1-graph/g02-directed-relation.v1.json",
    "evals/nir1-graph/g03-bounded-two-hop.v1.json",
    "evals/nir1-graph/g04-scope-exact-unknown.v2.json",
    "evals/nir1-graph/g05-current-revision-freshness.v1.json",
    "evals/nir1-graph/g06-evidence-anchor-path.v1.json",
    "evals/nir1-graph/g07-reading-before-reveal.v1.json",
    "evals/nir1-graph/g08-graph-index-fallback.v1.json",
  ]) {
    const fixture = read(relative);
    const needles = plaintextNeedlesOf(fixture);
    assert.ok(needles.length >= 6, relative);
    assert.ok(
      needles.every((text) => text.length >= 15),
      relative,
    );
    // No label (short) and no relation-type word is a needle.
    for (const entity of fixture.entities ?? [])
      assert.ok(!needles.includes(entity.label), `${relative} ${entity.label}`);
  }
  // G-01 and the added Scene's `sceneExcerpt.body`.
  assert.ok(
    plaintextNeedlesOf(read("evals/nir1-g01/fixture.v1.json")).includes(
      "Mira folded the blue cloth into a square and placed it beneath the brass bowl.",
    ),
  );
  // G-05: a summary edit's superseded text (copper) is a needle too.
  assert.ok(
    plaintextNeedlesOf(
      read("evals/nir1-graph/g05-current-revision-freshness.v1.json"),
    ).includes("Xan carries a copper lamp on night watch."),
  );
});

test("v3 §4: 拒否のエラー文は拒否した平文を運ばない（key が本文でも [key#n] に置き換える）。run-report と validation に書かれるため", () => {
  const needles = ["Mira folded the blue cloth into a square"];
  const text = "Mira folded the blue cloth into a square and more";
  const keyed = { ...goodReceipt(), map: { [text]: 1 } };
  const errors = plaintextErrors(keyed, needles);
  assert.ok(errors.length > 0);
  assert.ok(errors.every((error) => !error.includes("Mira folded")));
  assert.match(errors.join(), /map\.\[key#0\] \(a key\)/u);
  // A value's text never reaches the message either.
  const valued = { ...goodReceipt(), note: text };
  assert.ok(
    plaintextErrors(valued, needles).every((error) => !error.includes("Mira")),
  );
  // An unknown key of a new field, a text as a key, and a prototype name.
  const bad = goodReceipt();
  bad.samples[0].followUp.child.rowExcerpts[0][text] = "x";
  bad.samples[0].followUp.child.rowExcerpts[0].constructor = "x";
  const shaped = evidenceFieldErrors(bad);
  assert.ok(shaped.length >= 2);
  assert.ok(shaped.every((error) => !error.includes("Mira folded")));
  assert.match(shaped.join("\n"), /\[key#\d+\] is not a field/u);
  assert.match(shaped.join("\n"), /\.constructor is not a field/u);
});

test("v3 §4: 実物の ID の形（Evidence の ID は nir1:evidence:codex:<Entity の UUID>、sourceRef は codex:<UUID>）は新 field の ID の形に入る", () => {
  const uuid = "129faf50-ac4c-4fff-9639-6e1704270127";
  const receipt = goodReceipt();
  const row = receipt.evidenceObservation.typedRevisions[0].evidence[0];
  row.evidenceId = `nir1:evidence:codex:${uuid}`;
  row.sourceRef = `codex:${uuid}`;
  receipt.samples[0].followUp.child.evidence.graphOnly.edges[0].evidence[0].evidenceId = `nir1:evidence:codex:${uuid}`;
  receipt.samples[0].followUp.child.evidence.graphOnly.pinEntityId = uuid;
  assert.deepEqual(evidenceFieldErrors(receipt), []);
});

test("レビュー必須 1: evidenceObservation の null／undefined は「観測していない」で形の誤りにしない。値がある形の誤りは拒否する", () => {
  assert.deepEqual(evidenceFieldErrors({ samples: [] }), []);
  assert.deepEqual(
    evidenceFieldErrors({ samples: [], evidenceObservation: null }),
    [],
  );
  assert.deepEqual(
    evidenceFieldErrors({ samples: [], evidenceObservation: undefined }),
    [],
  );
  assert.notDeepEqual(
    evidenceFieldErrors({ samples: [], evidenceObservation: "text" }),
    [],
  );
  assert.notDeepEqual(
    evidenceFieldErrors({
      samples: [],
      evidenceObservation: { readAfterSamples: "yes" },
    }),
    [],
  );
});

test("レビュー推奨 4・5: page が返さなかった文字列は空文字の hash でなく null、undefined は null に揃える", () => {
  const hashed = hashGraphEvidence({
    graphOnly: {
      sceneId: "u-s1",
      hop: 1,
      pinEntityId: "e-mira",
      canonicalRange: { start: 0 },
      edges: [
        {
          from: { entityId: "e-a" },
          to: {},
          evidence: [{ evidenceId: "ev-1" }, { quote: "q" }],
        },
      ],
    },
    pathAttachments: [{ sceneId: "u-s2", edges: [] }, {}],
  });
  assert.equal(hashed.graphOnly.excerptSha256, null);
  assert.equal(hashed.graphOnly.excerptUtf16Length, null);
  assert.equal(hashed.graphOnly.canonicalRange.end, null);
  assert.equal(hashed.graphOnly.edges[0].to, null);
  assert.equal(hashed.graphOnly.edges[0].evidence[0].quoteSha256, null);
  assert.equal(hashed.graphOnly.edges[0].evidence[1].evidenceId, null);
  assert.equal(
    hashed.graphOnly.edges[0].evidence[1].quoteSha256,
    sha256Text("q"),
  );
  assert.equal(hashed.pathAttachments[0].hop, null);
  assert.equal(hashed.pathAttachments[1].sceneId, null);
  // An empty text is a text (its hash is a measured value); a missing one is not.
  assert.equal(
    hashRowTexts([{ sceneId: "s", kind: "raw", text: "" }])[0].excerptSha256,
    sha256Text(""),
  );
  assert.deepEqual(hashRowTexts([{ sceneId: "s", kind: "raw" }]), [
    {
      sceneId: "s",
      kind: "raw",
      excerptSha256: null,
      excerptUtf16Length: null,
    },
  ]);
  const read = hashRevisionRead({
    logicalRevisionId: "r",
    runtimeRevisionId: "rt",
    read: {
      ok: true,
      value: {
        status: "available",
        result: { entities: [{ evidence: [{ evidenceId: "ev-1" }] }] },
      },
    },
  });
  assert.equal(read.evidence[0].quoteSha256, null);
  assert.equal(read.evidence[0].startUtf16, null);
  // Every one of these is a shape the receipt check accepts (a null leaf), and
  // none carries text.
  assert.deepEqual(
    evidenceFieldErrors({
      samples: [{ followUp: { child: { evidence: hashed } } }],
      evidenceObservation: {
        readAfterSamples: true,
        samplesBeforeRead: 1,
        typedRevisions: [read],
      },
    }),
    [],
  );
});

test("レビュー推奨 10: evidenceRaw・rowTexts の key は受領書のどこにあっても拒否する（値が空でも）。needle が無くても key は見る", () => {
  const needles = ["Mira folded the blue cloth"];
  assert.deepEqual(plaintextErrors({ a: { b: [{ c: 1 }] } }, needles), []);
  for (const key of ["evidenceRaw", "rowTexts"]) {
    const errors = plaintextErrors(
      { samples: [{ fetches: [{ [key]: [] }] }] },
      needles,
    );
    assert.equal(errors.length, 1, key);
    assert.match(errors[0], /page-only plain field/u);
    assert.ok(!errors[0].includes("Mira"), "the message carries no text");
  }
  const noNeedles = plaintextErrors({ rowTexts: null }, []);
  assert.equal(noNeedles.length, 2);
  assert.match(noNeedles[0], /\[precheck\]/u);
});
