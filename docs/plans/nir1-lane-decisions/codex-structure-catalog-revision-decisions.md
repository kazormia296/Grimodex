# Codex 構造抽出の codex-catalog の印の判断記録

対象は、Codex の構造抽出（`startCodexStructureExtraction`、画面は開発用の flag の裏の
`CodexStructureExtractDialog`）が、実際の DB に提案の組を保存するときに必ず
`NEX_READ_SET_STALE` で失敗する件。見つけたのは同定の review の負荷の測定（AI なしの経路）で、
同定の規則の改訂案（`docs/plans/nir1-identity-correction-adr-amendment-draft.md`）の適用先なので、
保存できないと実装に進めない。基点は `origin/master` の `89df67ef`。

## 原因

提案の ReadSet には `project:codex-catalog:<projectId>`（sourceKind `codex-catalog`）が入る。

- renderer は印を `digestStableJson(codexCatalogVersionVector(...))`（entry・relation・type の
  sourceKey と version の digest）で作っていた。
- Native は `source_revision.rs` の `resolve_codex_catalog` で、Codex の 10 表（entry、relation、
  phase、detail の定義と値、type、tag、entry と tag の対応、semantic binding、phase の detail の上書き）の
  内容の digest を計算し、保存（`save_proposal_set`）と取り込み（prepare／apply）で照合する。

2 つは作り方が違うので、空の Codex でも常に食い違う。git の履歴では、`codex-catalog` の resolver を
入れた #526 では Native も id と version の digest で、renderer と同じ形だった。#543（C2-1 の
incremental freshness）が Native を内容の digest に広げた（試験
`codex_catalog_digest_tracks_unversioned_and_same_version_semantic_content`：version の無い type や
tag の変更、同じ id・version の作り直しも別の印にする）が、renderer の側を合わせなかった。
単体の試験は Native を mock していたので、食い違いは実 Native の上でしか見えなかった。

## DR-CSX-1 印は Native のものを正とし、renderer は Native から受け取る

### 決定

- 正は Native の内容の digest。incremental freshness（`incremental_freshness.rs` は Codex の各表の
  変更を `project:codex-catalog:<id>` の dirty に写す）、restore（`restore_rebuild.rs`）、
  dependency edge がこの印を使い、#543 の試験がその範囲を固定している。renderer の version vector に
  戻すと、version の無い変更を見落とす側に弱まる。
- 読み取り専用の IPC `narrative_extraction_resolve_codex_catalog_revision` を足す。
  - payload は `{ projectId }` だけ。sourceKey と sourceKind は Native が決める（renderer は他の
    Source を問えない）。返すのは `{ sourceKind, sourceKey, revisionToken }`。
  - 計算は保存・取り込みの照合と同じ `resolve_source_revision(..., "codex-catalog", ...)`。
  - 抽出で取った workspace binding に固定する（`narrative_extraction_bound_write_cmd` を使う。
    書き込みはしない）。main の `ipcContract.ts` で payload の key・projectId・binding を再検証する。
- renderer は TS で digest を再現しない。Native の 10 表の列と、serde_json の数値の書き方
  （`sortOrder` の f64 は `1.0`）を TS で写すと、今回と同じ形でまた食い違う。
- `startCodexStructureExtraction` は、workspace binding を取った直後に印を受け取り
  （`src/features/codex/codexCatalogRevision.ts` の `captureCodexCatalogRevision`）、その後に DB の
  entry と、semanticKey のある relation の id・version を読み直して、呼び出し元が渡した材料の catalog と
  比べる。違えば `NEX_READ_SET_STALE: Codex catalog changed after the extraction material was read` で
  止める（作者は抽出をやり直す）。比べる範囲が relation のうち semanticKey のあるものだけなのは、
  `buildExistingRelationCatalog` が semanticKey の無い relation を材料に入れない（照合に使えない）ため。
- 印の後に Codex が変われば、保存と取り込みで Native が `NEX_READ_SET_STALE` を返す（従来どおり）。
- Run の `catalogDigest` にも同じ Native の印を入れる（Codex の Run では Native はこの値を検証しない。
  run の記録と ReadSet の印を 1 つの出所にそろえる）。

### 信頼境界と restricted profile

- 返すのは作者自身の Codex の内容の sha256 だけ。平文も、新しい送信先も、保存の範囲の拡大も無い。
- restricted profile の route は `internal`（`profileEgress.ts` の `INTERNAL_COMMANDS`）。同じ流れの
  `narrative_extraction_capture_workspace_binding`／`create_run`／`save_proposal_set` と同じ区分。
  K3/2 の plaintext-publication の台帳（`narrative_extraction_claim_task` と `nir1_pack_context` の
  2 件に固定）は変えない。restricted ではこの経路の保存は従来どおり `claim_task` の拒否で止まるので、
  restricted で通る操作は増えない。own-data-read の台帳（draftRef が要る）にも入れない。
- `policies/narrative/change-feed-writers.json` では読み取りとして `ignoredCommands` に入れる
  （`narrative_extraction_` の接頭辞が writer の候補に当たるため）。

### 検証

- `electron/main/codexStructureExtraction.pipeline.spec.ts`（実 router・実 Native addon。
  `vitest.electron-native.config.ts`）：sample の作品で、AI なしの抽出の提案の組を保存 →
  store を空にして restore → 1 件を承認 → manual-apply で取り込み、まで通す。材料を読んだ後に
  Codex の項目を足すと、保存の前に止まることも確かめる。修正前は同じ spec が
  `NEX_READ_SET_STALE: input 'project:codex-catalog:default-project' expected 'sha256:8a56…' but found 'sha256:fcd4…'`
  で落ちた。
- Rust：新しい関数が ReadSet の resolver と同じ印を返し、空・前後に空白のある projectId を拒むこと。
- IPC 契約：正常系、payload・binding の不正、backend の不在。

## 記録：一括承認の可否の live と restore の違い（直すかは別に判断）

restore の経路（`rebuildEntityFromNative`）は、Entity の safety を作るときに
`hasProperNameMention: true` に固定し、`hasRelationDeps` を渡さない（`noRelationDeps` も常に true）。
live の経路は seed の form（固有名か）と提案の依存で決める。

- AI なしの prepass（sample の作品、13 件）では、旗の差は 0、一括承認の対象は live・restore とも 3 件で
  揃った。prepass の seed はすべて固有名で、Entity の提案に依存は無いため。
- 固有名でない seed（form `alias`）を注入すると分かれる：live は `explicitProperName=false` で一括承認の
  対象外、restore 後は `explicitProperName=true` で対象になる。restore は live より緩い向きにだけずれる。
- pipeline spec はこの現状を期待として固定している。直す場合は、その期待を「揃う」に反転する。
- `hasRelationDeps` の差は、Entity の bind の提案が依存を持つ経路（AI あり）で同じ向きに現れうる。
  AI なしの経路では観測していない。

## 残すこと

- 呼び出し元が材料の catalog を読んでから印を受け取るまでの間の、version の無い変更（type の label、
  tag など）は、材料との比較では見えない。印を受け取った後の変更は Native が止める。
- AI なしの経路で、作者が結び先を決めて承認しても表記が Codex の別名として保存されない件
  （`proposalPlanner.ts`、`codexStructureExtractionStore.ts`、`compiler.ts`）は、同定の規則の改訂案の
  扱いで、この判断の範囲外。
