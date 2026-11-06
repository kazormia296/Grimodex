# PUB-G 前提 #16 の実機 end-to-end（DR-CP3A-55）の結果（2026-11-07）

ユーザーの決定（2026-11-07）：案 (C) の第一段＝(A)（dev fixture で評価 build の実 Native を通す。S2／S4 の凍結に触れない）、合格基準は**到達の有無**、Linux の評価 build だけ。設計起案は 1 つ上の dir の `pubg-16-e2e-design-draft.md`。判断の記録は製品 repo の `docs/plans/nir1-lane-decisions/cp3a-decisions.md` の DR-PUBG-16-1（枝 `claude/pubg-16-e2e`、commit `75cf4549`）。

## 結果

- 候補は `2cb73eec`、Linux、評価 build（feature `nir1-graph-eval`）。fixture は既存の `dev-fixtures/dev-lantern.v1.json`。runner は `scripts/quality/nir1-graph-eval/pubg16-e2e-run.mjs`（S4 の pin の閉包の外。heldSample の前に body を宣言する）。
- **reach-4〜6（判定の根拠）**：3 回とも全段に到達した。begin は pending、continue は available（graphOnly）、click は `qualified`（`keep_click` を通る経路。Opus の独立検証でコードから確認）、unused settle の応答は `settled`、graph-ready は 1 件、再 begin は Native の `cached`、再 continue は available、**used settle の応答は `settled`**（timing shim の `__cp4IpcTiming` の "used" の行。unused→used の順に 2 行）。
- **reach-1〜3 は used settle の根拠にしない**：当初の判定は「例外なし＋slot empty」だった。settle は失効していても例外を出さず `cancelled` を返し、slot は owner の slot で cached と無関係なので根拠にならない、と独立検証が指摘した。reach-1 の JSON は古い判定のまま（allReached false）で、後の判定では 3 本とも true だった。
- **na-1**：評価 feature の無い製品 `.node`（sha `6dfbd5ea…`。build の受領書は無い。`native-architecture.mjs --expect product` は ok）で、seed つき begin が `unavailable: not-activated` を返し、continue・click に進まない（DR-CP3A-58）。
- 記録に入れたのは status・reason・ms・到達の有無・hash だけで、本文・識別子は入れない。

## 限界

Linux の評価 build だけ（3 OS は未確認）。precision は測っていない。試していないこと：lease が失効した後の click、settle の後の click、再 continue の graphOnly の click。admission の purpose は既存の `dprime-check` を流用した。G-01 相当の確認は CP-4 の次の正式 run に組み込む（決定 (C)）。判定は settle の行を `.some` で見ていて、行の数と順序は見ていない（3 本は [unused, used] の 2 行を満たす）。
