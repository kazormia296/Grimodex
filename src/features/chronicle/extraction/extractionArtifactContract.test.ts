/**
 * Chronicle 抽出の途中の記録（narrative_extraction_artifacts）の契約を固定する試験。
 * 正本は docs/plans/nir-extraction-artifact-contract.md。
 *
 * - DR-NAC-2: artifact kind の一覧と版
 * - DR-NAC-3: 観測の内容ベース同一性キー（observationMerger の実装を pin）
 * - DR-NAC-4: 保持の方針（削除は project 削除だけ）と依存の棚卸し
 *
 * 製品の挙動は変えない。契約と今の実装が食い違う変更が入ったら、この試験が落ちる。
 * 落ちたときは実装を直す前に契約の文書の該当節を読み、契約を変えるなら
 * 文書と一緒にこの試験を更新する（版を上げるなら @2 を足し、@1 の読み手を残す）。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CHRONICLE_EXTRACT_ARTIFACT_KINDS } from "@/application/narrative-extraction/extractionContract";
import type { RawEvidenceReference } from "@/features/narrative-extraction/evidence/types";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type {
  NarrativeAssertionContext,
  RawChronicleEventObservation,
} from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { mergeObservationsByEvidence } from "./observationMerger";

const REPO_ROOT = process.cwd();

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

// ---------------------------------------------------------------------------
// DR-NAC-2: artifact kind の版の凍結
// ---------------------------------------------------------------------------

describe("DR-NAC-2 artifact kind の一覧と版", () => {
  it("kind の一覧と版は増減・改名・版上げで落ちる", () => {
    expect(CHRONICLE_EXTRACT_ARTIFACT_KINDS).toEqual({
      snapshot: "source.snapshot@1",
      windowPlan: "source.window-plan@1",
      observations: "chronicle.raw-observations@1",
      resolvedEvidence: "evidence.resolved@1",
      mergedObservations: "chronicle.merged-observations@1",
      clusters: "chronicle.event-clusters@1",
      hypotheses: "chronicle.event-hypotheses@1",
      stageSynthesisOutputs: "chronicle.stage-synthesis-outputs@1",
      matches: "chronicle.existing-event-matches@1",
      proposals: "chronicle.proposal-plan@1",
    });
    expect(Object.keys(CHRONICLE_EXTRACT_ARTIFACT_KINDS)).toHaveLength(10);
  });

  it("kind は `<名前>@<整数>` で、重複しない", () => {
    const kinds = Object.values(CHRONICLE_EXTRACT_ARTIFACT_KINDS);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const kind of kinds) {
      expect(kind).toMatch(/^[a-z]+(?:[.-][a-z]+)+@[1-9]\d*$/u);
    }
  });

  it("Rust 側（resume 検証と stage provenance）が同じ kind の文字列を持つ", () => {
    const repository = readRepoFile(
      "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
    );
    const stageProvenance = readRepoFile(
      "src-tauri/crates/grimodex-db/src/narrative_extraction/stage_provenance.rs",
    );
    const rustKindSources = `${repository}\n${stageProvenance}`;
    for (const kind of Object.values(CHRONICLE_EXTRACT_ARTIFACT_KINDS)) {
      expect(rustKindSources, `Rust に ${kind} が無い`).toContain(`"${kind}"`);
    }
    // resume 検証の TASK_ARTIFACTS は companion の stage-synthesis-outputs を含めない 9 組。
    const taskArtifacts =
      /const TASK_ARTIFACTS: \[\(&str, &str\); (\d+)\]/u.exec(repository);
    expect(taskArtifacts?.[1]).toBe("9");
  });

  it("Rust の IR（cold build）が読む evidence.resolved@1 の anchor field は TS の型に在る", () => {
    // nir1_chronicle_index/evidence.rs が anchors[] から読む field。
    // これらの名前・意味は互換 adapter なしに変えない。
    const RUST_READ_ANCHOR_FIELDS = [
      "id",
      "documentRef",
      "quote",
      "quoteDigest",
    ] as const satisfies readonly (keyof ResolvedEvidenceAnchor)[];
    const evidenceRs = readRepoFile(
      "src-tauri/crates/grimodex-db/src/narrative_extraction/nir1_chronicle_index/evidence.rs",
    );
    for (const field of RUST_READ_ANCHOR_FIELDS) {
      expect(
        evidenceRs,
        `evidence.rs が anchor["${field}"] を読まない`,
      ).toContain(`anchor["${field}"]`);
    }
    expect(evidenceRs).toContain('["canonicalRange"]["start"]');
    expect(evidenceRs).toContain('["canonicalRange"]["end"]');
  });

  it("Rust の material roster が読む観測の field（localId の window 接頭辞）を固定する", () => {
    const replay = readRepoFile(
      "src-tauri/crates/grimodex-db/src/narrative_extraction/material_roster/replay.rs",
    );
    // localId は `<windowId>:...` で、window 計画の windowId と 1 対 1 に対応する。
    expect(replay).toContain('"/localId"');
    expect(replay).toContain('"/windowId"');
    expect(replay).toContain('id.starts_with(&format!("{w}:"))');
    // クラスタの observationRefs と snapshot の evidence catalog の版も、名前で読まれる。
    expect(replay).toContain('"observationRefs"');
    expect(replay).toContain('["evidence"]["catalog"]["segmentationVersion"]');
    expect(replay).toContain('"/windows"');
  });
});

// ---------------------------------------------------------------------------
// DR-NAC-3: 観測の内容ベース同一性キー
// ---------------------------------------------------------------------------

type Payload = RawChronicleEventObservation["payload"];
type FieldRole = "identity" | "excluded";

/**
 * 観測の各 field が merge の同一性キーに入るか。`Record<keyof ...>` なので、
 * 型に field が増減すると tsc が落ちる（増えた field の扱いを必ず決めさせる）。
 */
const OBSERVATION_FIELD_ROLES = {
  localId: "excluded",
  evidence: "identity",
  assertion: "identity",
  payload: "identity",
} as const satisfies Record<keyof RawChronicleEventObservation, FieldRole>;

const EVIDENCE_FIELD_ROLES = {
  sourceRef: "identity",
  quote: "identity",
  prefix: "excluded",
  suffix: "excluded",
} as const satisfies Record<keyof RawEvidenceReference, FieldRole>;

const ASSERTION_FIELD_ROLES = {
  attribution: "identity",
  narrativeFrame: "identity",
} as const satisfies Record<keyof NarrativeAssertionContext, FieldRole>;

type Participant = Payload["participants"][number];

/**
 * participants は配列ごと JSON.stringify されるので、要素の field も全て同一性に入る
 * （要素の型に field が増えると tsc が落ちる）。
 */
const PARTICIPANT_FIELD_ROLES = {
  surface: "identity",
  role: "identity",
} as const satisfies Record<keyof Participant, FieldRole>;

const PAYLOAD_FIELD_ROLES = {
  predicate: "identity",
  semanticType: "identity",
  actuality: "identity",
  participants: "identity",
  locationSurface: "identity",
  temporalExpressions: "identity",
  durationKind: "identity",
} as const satisfies Record<keyof Payload, FieldRole>;

function baseObservation(
  overrides: Partial<Omit<RawChronicleEventObservation, "payload">> & {
    payload?: Partial<Payload>;
  } = {},
): RawChronicleEventObservation {
  const { payload, ...rest } = overrides;
  return {
    localId: "window-001:obs-001",
    evidence: [{ sourceRef: "E000001", quote: "扉が開いた。" }],
    assertion: { attribution: "narrator", narrativeFrame: "story-world" },
    ...rest,
    payload: {
      predicate: "扉が開いた",
      semanticType: "movement",
      actuality: "actual",
      participants: [{ surface: "兵", role: "agent" }],
      locationSurface: "北門",
      temporalExpressions: ["夜半"],
      durationKind: "instant",
      ...payload,
    },
  };
}

function mergedCount(
  ...observations: readonly RawChronicleEventObservation[]
): number {
  return mergeObservationsByEvidence(observations).length;
}

/** identity の field を 1 つだけ変えた観測。 */
const IDENTITY_MUTATORS = {
  "observation.evidence": () =>
    baseObservation({
      evidence: [{ sourceRef: "E000002", quote: "扉が開いた。" }],
    }),
  "observation.assertion": () =>
    baseObservation({
      assertion: { attribution: "narrator", narrativeFrame: "flashback" },
    }),
  "observation.payload": () =>
    baseObservation({ payload: { predicate: "別" } }),
  "evidence.sourceRef": () =>
    baseObservation({
      evidence: [{ sourceRef: "E000009", quote: "扉が開いた。" }],
    }),
  "evidence.quote": () =>
    baseObservation({
      evidence: [{ sourceRef: "E000001", quote: "扉が閉じた。" }],
    }),
  "assertion.attribution": () =>
    baseObservation({
      assertion: {
        attribution: "character:alice",
        narrativeFrame: "story-world",
      },
    }),
  "assertion.narrativeFrame": () =>
    baseObservation({
      assertion: { attribution: "narrator", narrativeFrame: "dream" },
    }),
  "payload.predicate": () =>
    baseObservation({ payload: { predicate: "閉じた" } }),
  "payload.semanticType": () =>
    baseObservation({ payload: { semanticType: "battle" } }),
  "payload.actuality": () =>
    baseObservation({ payload: { actuality: "rumored" } }),
  "payload.participants": () =>
    baseObservation({
      payload: { participants: [{ surface: "兵", role: "patient" }] },
    }),
  "participant.surface": () =>
    baseObservation({
      payload: { participants: [{ surface: "民", role: "agent" }] },
    }),
  "participant.role": () =>
    baseObservation({
      payload: { participants: [{ surface: "兵", role: "theme" }] },
    }),
  "payload.locationSurface": () =>
    baseObservation({ payload: { locationSurface: "南門" } }),
  "payload.temporalExpressions": () =>
    baseObservation({ payload: { temporalExpressions: ["夜明け"] } }),
  "payload.durationKind": () =>
    baseObservation({ payload: { durationKind: "ongoing-process" } }),
} as const satisfies Record<string, () => RawChronicleEventObservation>;

/** excluded の field だけを変えた観測（merge で同一に畳まれる）。 */
const EXCLUDED_MUTATORS = {
  "observation.localId": () =>
    baseObservation({ localId: "window-009:obs-099" }),
  "evidence.prefix": () =>
    baseObservation({
      evidence: [
        { sourceRef: "E000001", quote: "扉が開いた。", prefix: "前の文。" },
      ],
    }),
  "evidence.suffix": () =>
    baseObservation({
      evidence: [
        { sourceRef: "E000001", quote: "扉が開いた。", suffix: "次の文。" },
      ],
    }),
} as const satisfies Record<string, () => RawChronicleEventObservation>;

function tableKeys(
  scope: string,
  table: Record<string, FieldRole>,
  role: FieldRole,
): string[] {
  return Object.entries(table)
    .filter(([, value]) => value === role)
    .map(([key]) => `${scope}.${key}`);
}

describe("DR-NAC-3 観測の内容ベース同一性キー", () => {
  it("同一性キーの入力 field の一覧は、型の field と mutator の一覧に一致する", () => {
    const identity = [
      ...tableKeys("observation", OBSERVATION_FIELD_ROLES, "identity"),
      ...tableKeys("evidence", EVIDENCE_FIELD_ROLES, "identity"),
      ...tableKeys("assertion", ASSERTION_FIELD_ROLES, "identity"),
      ...tableKeys("payload", PAYLOAD_FIELD_ROLES, "identity"),
      ...tableKeys("participant", PARTICIPANT_FIELD_ROLES, "identity"),
    ];
    const excluded = [
      ...tableKeys("observation", OBSERVATION_FIELD_ROLES, "excluded"),
      ...tableKeys("evidence", EVIDENCE_FIELD_ROLES, "excluded"),
      ...tableKeys("assertion", ASSERTION_FIELD_ROLES, "excluded"),
      ...tableKeys("payload", PAYLOAD_FIELD_ROLES, "excluded"),
      ...tableKeys("participant", PARTICIPANT_FIELD_ROLES, "excluded"),
    ];
    expect(identity.sort()).toEqual(Object.keys(IDENTITY_MUTATORS).sort());
    expect(excluded.sort()).toEqual(Object.keys(EXCLUDED_MUTATORS).sort());
  });

  it.each(Object.entries(IDENTITY_MUTATORS))(
    "identity の field %s が違う観測は畳まれない",
    (_name, mutate) => {
      expect(mergedCount(baseObservation(), mutate())).toBe(2);
    },
  );

  it.each(Object.entries(EXCLUDED_MUTATORS))(
    "excluded の field %s だけが違う観測は畳まれ、先に来た行が残る",
    (_name, mutate) => {
      const first = baseObservation();
      const merged = mergeObservationsByEvidence([first, mutate()]);
      expect(merged).toHaveLength(1);
      expect(merged[0]?.localId).toBe(first.localId);
    },
  );

  it("evidence は整列した多重集合として扱う（順序に依らず、重複は保持する）", () => {
    const a = { sourceRef: "E000001", quote: "一つ目。" };
    const b = { sourceRef: "E000002", quote: "二つ目。" };
    // 順序が違っても、同じ内容なら畳まれる。
    expect(
      mergedCount(
        baseObservation({ evidence: [a, b] }),
        baseObservation({ localId: "window-002:obs-001", evidence: [b, a] }),
      ),
    ).toBe(1);
    // 重複は除かない。[a, a] と [a] は別の観測のまま。
    expect(
      mergedCount(
        baseObservation({ evidence: [a, a] }),
        baseObservation({ localId: "window-002:obs-001", evidence: [a] }),
      ),
    ).toBe(2);
    // 重複の数が同じなら畳まれる。
    expect(
      mergedCount(
        baseObservation({ evidence: [a, a] }),
        baseObservation({ localId: "window-002:obs-001", evidence: [a, a] }),
      ),
    ).toBe(1);
  });

  it("participants の要素は JSON のキー順も含めて比較する（surface／role の全 field が入る）", () => {
    // observationMerger は participants を JSON.stringify で丸ごと入れるので、
    // 要素の field の追加・削除に加え、キーの挿入順の違いも identity を変える。
    // 現状の挙動を pin する（モデル出力は schema を通った後の正規形なので、実害は無い）。
    expect(
      mergedCount(
        baseObservation({
          payload: { participants: [{ surface: "兵", role: "agent" }] },
        }),
        baseObservation({
          payload: { participants: [{ role: "agent", surface: "兵" }] },
        }),
      ),
    ).toBe(2);
  });

  it("participants と temporalExpressions は順序を含めて比較する", () => {
    const agent = { surface: "兵", role: "agent" };
    const patient = { surface: "民", role: "patient" };
    expect(
      mergedCount(
        baseObservation({ payload: { participants: [agent, patient] } }),
        baseObservation({ payload: { participants: [patient, agent] } }),
      ),
    ).toBe(2);
    expect(
      mergedCount(
        baseObservation({ payload: { temporalExpressions: ["夜半", "翌朝"] } }),
        baseObservation({ payload: { temporalExpressions: ["翌朝", "夜半"] } }),
      ),
    ).toBe(2);
  });

  it("省略された任意 field と未指定は同じ（semanticType／locationSurface は null 扱い）", () => {
    const withoutOptional = (): RawChronicleEventObservation => {
      const {
        semanticType: _s,
        locationSurface: _l,
        ...rest
      } = baseObservation().payload;
      return { ...baseObservation(), payload: rest };
    };
    const explicitUndefined: RawChronicleEventObservation = {
      ...withoutOptional(),
      localId: "window-002:obs-001",
      payload: {
        ...withoutOptional().payload,
        semanticType: undefined,
        locationSurface: undefined,
      },
    };
    expect(mergedCount(withoutOptional(), explicitUndefined)).toBe(1);
  });

  it("localId は window ごとのモデル出力に由来し、同一性にも安定 ID にも使わない", () => {
    // 同じ内容の観測は、window を跨いで localId が違っても 1 件に畳まれる。
    // localId の形（`<windowId>:obs-NNN`）は rekeyObservationsForWindow が window 内の連番で振る。
    const merged = mergeObservationsByEvidence([
      baseObservation({ localId: "window-001:obs-001" }),
      baseObservation({ localId: "window-002:obs-007" }),
    ]);
    expect(merged.map((entry) => entry.localId)).toEqual([
      "window-001:obs-001",
    ]);
    // 同じ localId でも内容が違えば別の観測のまま（localId では畳まない）。
    expect(
      mergedCount(
        baseObservation({ localId: "window-001:obs-001" }),
        baseObservation({
          localId: "window-001:obs-001",
          payload: { predicate: "別" },
        }),
      ),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// DR-NAC-4: 保持の方針（削除は project 削除だけ）と依存の棚卸し
// ---------------------------------------------------------------------------

const TABLE = "narrative_extraction_artifacts";

function isTestSourcePath(relativePath: string): boolean {
  return (
    /(^|\/)tests\//u.test(relativePath) ||
    /(^|\/)tests\.rs$/u.test(relativePath) ||
    /_tests\.rs$/u.test(relativePath) ||
    /\.(test|spec)\.[cm]?tsx?$/u.test(relativePath) ||
    /\.browser\.test\./u.test(relativePath)
  );
}

/** `#[cfg(test)]` の item（rustfmt の字下げで終端を判定）を空行に置き換える。 */
function stripRustCfgTest(source: string): string {
  const lines = source.split("\n");
  const out = [...lines];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!/^\s*#\[cfg\(test\)\]/u.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    let end = index + 1;
    // 次の item が `;` で終わる（`mod tests;` など）なら、その行だけ。
    if ((lines[end] ?? "").trimEnd().endsWith(";")) {
      for (let k = index; k <= end; k += 1) out[k] = "";
      index = end;
      continue;
    }
    while (end < lines.length) {
      const candidate = lines[end] ?? "";
      const candidateIndent = candidate.length - candidate.trimStart().length;
      if (candidateIndent === indent && candidate.trimStart().startsWith("}")) {
        break;
      }
      end += 1;
    }
    for (let k = index; k <= Math.min(end, lines.length - 1); k += 1) {
      out[k] = "";
    }
    index = end;
  }
  return out.join("\n");
}

function* walkFiles(directory: string): Generator<string> {
  const SKIP = new Set(["node_modules", "target", "dist", "dist-electron"]);
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry) || entry.startsWith(".")) continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

interface MutationSite {
  readonly file: string;
  readonly statement: string;
}

/** 製品コード（test を除く）での、指定 table への DML／DDL の場所を集める。 */
function productionMutationSites(table: string): MutationSite[] {
  // `UPDATE OR REPLACE <table>`（OR 句）と `main.<table>`（schema 修飾）、引用符付きも拾う。
  const pattern = new RegExp(
    `\\b(DELETE\\s+FROM|INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|UPDATE(?:\\s+OR\\s+\\w+)?|DROP\\s+TABLE(?:\\s+IF\\s+EXISTS)?|ALTER\\s+TABLE|TRUNCATE(?:\\s+TABLE)?)\\s+(?:["\`]?\\w+["\`]?\\.)?["\`]?${table}\\b`,
    "giu",
  );
  const sites: MutationSite[] = [];
  // scripts/ と electron/scripts/ は使い捨ての DB を操作する開発・CI の harness で、製品に同梱されない。
  // src-tauri/src は frozen legacy の Tauri shell だが、製品に同梱されうるので対象に含める。
  for (const root of ["src-tauri/crates", "src-tauri/src", "electron", "src"]) {
    const absoluteRoot = path.join(REPO_ROOT, root);
    for (const absolute of walkFiles(absoluteRoot)) {
      const relative = path.relative(REPO_ROOT, absolute).replaceAll("\\", "/");
      if (!/\.(rs|ts|tsx|mjs|cjs|js|sql)$/u.test(relative)) continue;
      if (isTestSourcePath(relative)) continue;
      if (relative.startsWith("electron/scripts/")) continue;
      // ブラウザ用の in-memory mock（native の DB ではない）。validate-narrative-writers と同じ除外。
      if (relative.includes("browser-mock")) continue;
      let text = readFileSync(absolute, "utf8");
      if (!text.includes(table)) continue;
      if (relative.endsWith(".rs")) text = stripRustCfgTest(text);
      for (const match of text.matchAll(pattern)) {
        sites.push({
          file: relative,
          statement: match[1]!.replace(/\s+/gu, " ").toUpperCase(),
        });
      }
    }
  }
  return sites;
}

describe("DR-NAC-4 保持の方針と依存", () => {
  it("artifact 行を消す製品コードは project 削除（domain_writes.rs）だけ", () => {
    const sites = productionMutationSites(TABLE).filter((site) =>
      site.statement.startsWith("DELETE"),
    );
    expect(sites).toEqual([
      {
        file: "src-tauri/crates/grimodex-db/src/domain_writes.rs",
        statement: "DELETE FROM",
      },
    ]);
  });

  it("artifact 行は追記だけ（INSERT は repository.rs の 1 箇所。UPDATE／REPLACE／DROP／ALTER／TRUNCATE は無い）", () => {
    const sites = productionMutationSites(TABLE).filter(
      (site) => !site.statement.startsWith("DELETE"),
    );
    expect(sites).toEqual([
      {
        file: "src-tauri/crates/grimodex-db/src/narrative_extraction/repository.rs",
        statement: "INSERT INTO",
      },
    ]);
  });

  it("run と project を消す製品コードも domain_writes.rs の project 削除だけ（artifact に FK は無く、run を先に消すと孤児になる）", () => {
    for (const table of ["narrative_extraction_runs", "projects"]) {
      const files = new Set(
        productionMutationSites(table)
          .filter((site) => site.statement.startsWith("DELETE"))
          .map((site) => site.file),
      );
      expect([...files]).toEqual([
        "src-tauri/crates/grimodex-db/src/domain_writes.rs",
      ]);
    }
    const domainWrites = readRepoFile(
      "src-tauri/crates/grimodex-db/src/domain_writes.rs",
    );
    const artifactDelete = domainWrites.indexOf(`DELETE FROM ${TABLE}`);
    const runDelete = domainWrites.indexOf(
      "DELETE FROM narrative_extraction_runs WHERE project_id",
    );
    expect(artifactDelete).toBeGreaterThan(-1);
    // artifact は run への join で消すので、run より前に消す。
    expect(artifactDelete).toBeLessThan(runDelete);
  });

  it("artifact 行に依存する読み手（契約が挙げる 11 経路。網羅ではなく既知の読み手）が今も在る", () => {
    // 存在確認だけを固定する（目印の文字列が cfg(test) を除いた本文に在る）。
    // 各経路の振る舞いは、それぞれの Rust 試験が固定する。
    // artifact を読む箇所はこの表で全部ではない。消す経路を作るときは、
    // `FROM narrative_extraction_artifacts` を読む全箇所を棚卸しする（契約 §5.3）。
    const base = "src-tauri/crates/grimodex-db/src/narrative_extraction/";
    const dependencies: readonly (readonly [string, string, string])[] = [
      // [file, 目印, 依存の名前]
      [
        `${base}repository.rs`,
        "NEX_CHRONICLE_RESUME_ARTIFACT_INCONSISTENT",
        "task resume",
      ],
      [
        `${base}nir1_chronicle_index/input_guard.rs`,
        `FROM ${TABLE} a JOIN narrative_extraction_runs r ON r.id=a.run_id WHERE r.project_id=?1`,
        "IR cold build の CAS（全 artifact 行を digest に含める）",
      ],
      [
        `${base}source_revision.rs`,
        "fn resolve_narrative_artifact(",
        "Source としての解決（artifact:<id>）",
      ],
      [
        `${base}restore_rebuild.rs`,
        `FROM ${TABLE} artifact`,
        "restore／rebuild（durable graph state の digest に artifact を含める）",
      ],
      [
        `${base}verify_coverage.rs`,
        "fn verify_application_revision_artifact_references_with_control(",
        "適用済み Revision が束縛する artifact の存在検証",
      ],
      [
        `${base}nir1_chronicle_index/evidence.rs`,
        "a.artifact_kind='evidence.resolved@1'",
        "承認済み Revision の根拠（anchor）の検証",
      ],
      [
        `${base}material_roster/replay.rs`,
        "fn accepted(",
        "material roster の replay（完了した Task／Attempt の artifact を厳密に選ぶ）",
      ],
      [
        "src-tauri/crates/grimodex-db/src/nir1_generation.rs",
        "NIR1_GENERATION_ARTIFACT_MISSING",
        "NIR-1 generation の入力束縛（artifact の存在と digest を検証する）",
      ],
      [
        `${base}scope_authority_runtime.rs`,
        `FROM ${TABLE}`,
        "scope authority（artifact から scope authority document を読む）",
      ],
      [
        `${base}material_membership_root.rs`,
        `FROM ${TABLE}`,
        "material membership root（run の artifact から root を作る）",
      ],
      [
        `${base}stage_provenance.rs`,
        `FROM ${TABLE} a,`,
        "stage provenance（stage-synthesis-outputs を読む）",
      ],
    ];
    for (const [file, marker, name] of dependencies) {
      const body = file.endsWith(".rs")
        ? stripRustCfgTest(readRepoFile(file))
        : readRepoFile(file);
      expect(body, `${name}: ${file}`).toContain(marker);
    }
    // restore／rebuild の読み出しは製品コードに 2 箇所ある（片方だけが消えても気づく）。
    const restore = stripRustCfgTest(readRepoFile(`${base}restore_rebuild.rs`));
    expect(restore.split(`FROM ${TABLE} artifact`).length - 1).toBe(2);
  });
});
