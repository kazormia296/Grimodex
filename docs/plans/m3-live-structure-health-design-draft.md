# 構造の健全性（案：「構造の点検」）に実際の件数を出す — M3 P0-B 設計草稿（draft）

| 項目 | 内容 |
| ---- | ---- |
| draftRef | `m3-live-structure-health/1`（草稿） |
| Status | draft。**最初の版（件数だけ。作者には見えないまま）は PR #1042 で実装・merge 済み（DR-M3-14）。この草稿の本文は、実装の前の設計で、書いた時点の記述のまま**。（以下は実装の前の記述）実装・既存コード・既存 docs は変えていない。**問い P1・P2・P3 は 2026-11-23 に構造化質問で回答済み**（置き場は今の画面のまま・場面へも飛べるように〔最初の版は件数だけ、「どの場面の提案か」を結ぶ読み取りは別の PR で足す。設計は未設計〕・ボタンは見えないまま入れる）。**問い P4〜P7 は未回答**。ボタンの見せ方（既定の公開）は公開に近い判断で、別に伺う。新しい IPC・契約・保存・AI への送信・閾値・ADR の改訂は、この草稿の範囲に入れていない（場面へ飛ぶための読み取りの追加は、新しい契約になりうるので、別の PR の設計で改めて扱う。§5）。**2026-11-25 追記：その後に確かめたことと、同日の回答は §8** |
| 基点 | worktree `claude-m3-docs`（枝 `claude/m3-docs-roadmap-erm0`、基点 `origin/master` `b7f8fa336`）。行番号はこの基点のもの |
| 由来 | roadmap の M3「Epic P0-B: Live Structure Health / Evidence Audit Inbox」（`docs/plans/narrative-semantic-core-roadmap.md:634-678`。**roadmap の行番号は基点 `b7f8fa336` の版のもの**。同じ PR が roadmap に追記する（P0-B の見出しは基点で :634、working tree で :645 と +11 行ずれる）ので、**節の名前で参照する**。行番号を併記するのは基点の版だけ）。Exit criteria の 1 つ目「実際の件数は、正本の Consumer Freshness と Finding の identity から出す。placeholder のデータではない」（:673）に向けた最初の薄い版 |
| ユーザーの決定（2026-11-23。記録の言葉に合わせる） | ①範囲は LSB ロードマップの「M3 まで」（M4 は範囲外）。②M3 の技術判断（作り方、PR の分け方、試験）を、NIR-1 の残りの lane と同じ範囲で事前に任せる（新しい契約・保存範囲の拡大・AI への新しい送信・閾値の緩和は個別に伺う）。③訂正を覚える機能（ERM）は、同定の review の負荷を先に測る。④方針の問い（**ERM の契約の★1・2・3・6・7**）は、測定と並行で先に伺う。⑤凍結の後でも、M3 の製品の変更は master に merge してよい。記録の正本は contracts 枝の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-23-m3-pullforward.md`（commit `71e45bb4`）。**この草稿の問い（下の「問い P1〜P7」：置き場・場面へ飛ぶか・既定の見せ方・文言など）は、ERM の★とは別の問いで、上の決定に含まれない**。この草稿の「推奨」はどれも起案者の意見で、ユーザーの決定ではない（P1・P2・P3 は 2026-11-23 に回答があり、各問いに「2026-11-23 の回答」として足した。推奨の文は書き換えていない） |
| 表記 | 【確認済み】は今の worktree で読んだもの。【未確認】は読んでも確かめていないもの、実行していないもの。調査 agent の報告は出所として読んだだけで、引用はすべて今の内容で確かめ直した |

用語：**Inbox**＝`narrative_maintenance_inbox_list` が返す「保守が気にしている項目」の一覧（正本は Consumer ごとの Freshness の表）。**Consumer**＝根拠の本文に依存する側の単位（提案の 1 つの版、適用済みの結果、など）。**Freshness**＝依存する根拠が今も有効かの状態（fresh／stale など）。**feature rules**＝roadmap :648-657 の、Codex の項目や関係を点検する 6 つの規則。**Work Layer**＝ヘッダーの Task Tray／All Work などの作業の層（ADR 012）。

## 一枚目：何を作るか、置き場の推奨、伺う問い

何を作るか（要点）
- 伏線パネルの「健全性」ボタン（title「構造の健全性（プレビュー）」）から開く既存のモーダル（`StructureHealthPanel`）に、**今ある数字**を出す。今は「Change Feed の基盤だけが有効です」と固定の文だけが出ている【確認済み：`StructureHealthPanel.tsx:41-49`、`structureHealthModel.ts:1-21`】。
- 数字は、既存の読み取り専用の経路 `narrative_maintenance_inbox_list`（IPC・main・N-API・Rust まで実装済み、renderer の呼び手は 0 件）から出す。**最初の版（件数だけ）は、新しい IPC・保存・AI への送信を足さない**。この前提は最初の版に限る。P2 の回答（2026-11-23）で、場面へ飛ぶための読み取りの追加が別の PR として必要になった（新しい IPC か既存の読み取りの拡張か。未設計。§5）。
- 読むのは、**モーダルを開いたときに 1 回だけ**。既定では閉じていて、開くまで何も読まない。自動では何も直さない。通知もバッジも出さない。
- 最初の版が数えるのは「根拠が古くなった提案」（内訳に、本文が変わったもの）を中心にした数件の種類だけ。feature rules（§3.2）は最初の版に入れない（実装が無く、一部は ERM が前提。入れる時期は未確認で、決まっていない）。P0-B の完了とは書かない（Exit criteria の 4 項目のうち、最初の版が満たすのは 1 つ目の一部だけ。§7）。
- この機能は、Consumer の契約が「まだ model されていない」と予約している `structure-health-diagnostic`（§1.2）を**新しい Consumer にしない**。Inbox を数えるだけで、診断の結果を保存しないので、この予約と衝突しない。

置き場の推奨（起案者の意見。決めるのはユーザー。問い P1 の回答待ち）
- 推奨は、最初の置き場を**今のモーダルのまま**にすること（伏線パネルの「健全性」ボタン）。理由は、すでに mount 済みで、`ForeshadowPanel.tsx` に 1 行も触れずに実数を出せるから（§4）。
- 将来の置き場は Work Layer（ADR 014 D6 に沿う）が本来で、その移設は、実データへの配線の設計ができてから、という見方を推奨する。移設の時期・やるかどうかは**ユーザーの確認待ち**で、決まっていない（問い P1）。

問い（作者から見える場面の言葉で。選択肢と推奨。**「問い P1〜P7」は、ERM の契約の★1〜★8 とは別の番号**。この草稿の問いはどれもユーザーの確認待ち）
- 問い P1 **どこで見られるようにするか**：A＝今の伏線パネルの「健全性」ボタンのまま数字を出す（推奨）／B＝作品全体の「作業の層」（ヘッダーの Task Tray 側）に出す／C＝エディタの横のペインの、今の場面の中に出す。B・C は別の設計が要る（§4）。
  - 2026-11-23 の回答：「この画面のまま・場面へも飛べるように」（P1 と P2 をまとめた問い）。置き場は今の伏線パネルの「健全性」から開く画面のまま（→ 回答：A）。Work Layer への移設の時期・やるかどうかは、引き続き決まっていない。
- 問い P2 **押した行から、その場面へ飛べるようにするか**：A＝最初の版は件数だけで、場面へは飛ばない（推奨）／B＝場面に結ぶ読み取りを別の PR で足す。今の一覧には「どの場面の提案か」が入っていないため（§5）。
  - 2026-11-23 の回答：上の「この画面のまま・場面へも飛べるように」。場面へも飛べるようにするが、**最初の版は件数だけ**（今の読み取りが「どの場面の提案か」を持たないため）。「どの場面の提案か」を結ぶ読み取りを**別の PR で足す**。この読み取りの追加（新しい IPC か、既存の読み取りの拡張か）の設計は、これから（**未設計**。§5）。
- 問い P3 **今の既定のままだと、作者には「健全性」ボタン自体が見えない**：ボタンは、「作品の保守機能」の許可が入っているときだけ出る。この許可は既定で切れていて、作者が入れる画面は、今の画面のコードには確認できなかった（読んだ限り。§1.5）。最初の版は「見えない状態のまま入れる」（推奨）か、作者が許可を入れる画面を別に設計するか、既定を変えるか。許可は保守のほかの動作の前提にもなっているので、既定を変えるのは別の判断（§1.5）。公開に近い判断なので、先に伺う。
  - 2026-11-23 の回答：「見えないまま入れる（推奨）」を選んだ（→ 回答：推奨どおり）。ボタンの見せ方（作者に出すか）は公開に近い判断で、別に伺う（未回答）。
- 問い P4 **数字の見せ方**：「根拠が古くなった提案」を、変わり方ごとの内訳（本文そのものが変わった／根拠の場面が見つからない／根拠の位置が合わない、など）で出すか、1 つの合計だけにするか。内訳（推奨）。画面の見出しの文言（「根拠が古くなった提案」など）も、この問いと一緒にユーザーが決める（§3.1 は案）。
- 問い P5 **「保守が止まった」件数を同じ画面に出すか**：AI の抽出の保守が途中で止まった記録（terminal failure）も、同じ一覧の中に入っている。同じモーダルに別の行として出す（推奨）か、最初の版は出さないか。
- 問い P6 **0 件の言い方**：一覧が空のときは「問題なし」と読めてしまうが、実際は「まだ点検の対象がない」ことと区別できない（§3）。0 件のときの文言は「点検の対象がまだありません」とし、「正常」とは言わない（推奨）。
- 問い P7 **ボタンと画面の名前**：今のボタンの文言は「健全性」、title は「構造の健全性（プレビュー）」（`ForeshadowPanel.tsx:445-449`、`ja.json` の `narrativeMaintenance.openPreview`／`shortLabel`）。この草稿は、画面の名前を「構造の点検」に改める案（§6.1）を持つが、これは**改名の案で、今の名前ではない**。改めるか、「プレビュー」を残すかを伺う（推奨は、feature rules が無い間は「一部の点検だけ」と画面に明示する、§6.1）。あわせて、まだ点検できない項目（feature rules）の一覧を画面に出さない案（推奨）も伺う（§3.2）。

## 1. 現状（確かめた事実）

### 1.1 Inbox の IPC の端から端【確認済み】

| 層 | 場所 | 内容 |
| -- | ---- | ---- |
| IPC 契約 | `electron/shared/ipcContract.ts:1244` | `narrativeMaintenanceInboxList?(payload: unknown): Promise<string>` |
| 検証 | `electron/shared/ipcContract.ts:1870-1885` | 入力は `{ payload: { projectId } }` だけ。余分な key は `unknown field` で拒否、`projectId` は空でない文字列 |
| main の実行 | `electron/shared/ipcContract.ts:11634-11643` | `NAPI_COMMANDS.narrative_maintenance_inbox_list`。N-API の戻りの文字列を `parseWire`（`JSON.parse` だけ、`:6784-6786`）で返す |
| N-API | `electron/native/grimodex-node/src/lib.rs:16325-16340`、`index.d.ts:1179` | `now` は Native が `now_rfc3339_millis()` で入れる。renderer は時刻を渡せない |
| Rust | `src-tauri/crates/grimodex-db/src/narrative_extraction/inbox_read_model.rs`（`build_maintenance_inbox`、:407-） | 書かない。モジュール冒頭（:3）と関数の説明（:393-397）が「`INSERT`／`UPDATE`／`DELETE` を発行せず、期限切れの保留（snooze）も自動で消さない」と明記 |

- 戻りは `InboxEntry` の配列。**件数の上限・ページ送りは無い**（全件を 1 回で返す）。Consumer の 1 行ごとに、観測（Finding Observation）と作者の保留（Attention）を引いている（:419-470）。大きい作品での件数と時間は**未測定**【未確認】。
- 現在の Semantic Epoch が無い project では**空配列**を返す（:415-417）。Consumer が 1 つも無い project も空配列で、**呼び手からは区別できない**。
- **有効な保留（snooze）で隠れた Consumer は返らない**（:440-468 付近）。dismissed／flagged は隠れずに返る。renderer から保留を付ける呼び手も src/ に見つからないため、実際に隠れる行があるかは**未確認**。

### 1.2 返ってくる値の形（wire）【確認済み、実際の wire の観測は未確認】

- `InboxEntry` の field：`entry_kind`（`consumer-freshness`／`terminal-failure`）、`consumer_kind`、`consumer_key`、`evidence_freshness`、`build_action`、`finding_key`、`latest_observation`、`attention`、`is_snoozed_and_active`（`inbox_read_model.rs:214-224`）。
- **キーは snake_case と読める（コードの上では確認済み。実行での観測だけが未実施）**。`InboxEntry`・`FindingObservationRow`・`AttentionRow` は `Serialize` の derive だけで `rename_all` が無い（列挙 `InboxEntryKind` だけ `kebab-case`：:128-132）。N-API は `serde_json::to_string(&entries)` を加工せず返し（`lib.rs:16336`）、main は `JSON.parse` するだけ（`parseWire`：`ipcContract.ts:6784-6786`）で、途中に key を変換する層が無い。同じ系統の `SceneProposalItem` が `#[serde(rename_all = "camelCase")]` を明示している（`scene_proposals.rs:161-163`）のとは対照的。journey の script のうち、c2zc の journey は snake_case の key（`entry_kind`・`evidence_freshness`・`build_action`・`latest_observation`・`attention`・`is_snoozed_and_active`）だけを読み、fallback を持たない（`electron/scripts/c2zc-canonical-product-journey.mjs:676-682`）。`narrative-maintenance-product-journeys.mjs:3255-3277` は `consumer_kind ?? consumerKind` と両方を見る（防御的な書き方で、実際の形の証拠にはならない）。調査 agent の報告は「camelCase か未確認」としていたが、上のとおり、コードの上では snake_case と読める。実際の戻りを実行で観測するのは未実施（§7.3-1）。
- wrapper で snake_case のまま型を付けるか、camelCase に写して検証するかは技術判断（委任の範囲）。推奨は、wrapper が受け取った値を検証して camelCase の型に写す形（未知の `evidence_freshness` の値は「判定不能」に数え、throw しない）。
- `consumer_kind` の値は `narrative-extraction-run`、`proposal-revision`、`application`、`semantic-index`、`narrative-maintenance-failure`（terminal failure の行）。調査 agent の報告の「`run`」は誤りで、実際の値は `narrative-extraction-run`（`consumer_identity.rs:113-115`）。
- 契約 `policies/narrative/narrative-consumer-contract.json` の `consumerKinds` は **11 種**（この file の `consumerKinds` を数えた）：
  - `declared` 3：`narrative-extraction-run`、`proposal-revision`、`application`
  - `reserved` 4：`extraction-artifact`、`application-contribution`、`derived-projection`、`semantic-index`
  - `not-yet-modelled` 4：`narrative-ir-revision`、`related-scenes-materialization`、`chat-context-materialization`、**`structure-health-diagnostic`**
  - `structure-health-diagnostic` は、この機能そのものの名前の予約で、契約の notes は、durable な table が無いこと、`StructureHealthPanel.tsx` がまだ Gate C0 の placeholder（`liveCountsAvailable: false`）であること、`narrative_maintenance_finding_observations` は `finding_key` で引く rebuildable な観測履歴で、それ自体が Consumer になれる durable な診断 artifact ではないこと、を理由に挙げる。**最初の版は、Consumer を足さず（診断の結果を保存せず）、既存の Inbox を数えるだけなので、この予約と衝突しない**。ただし、実数が出るようになると、契約の notes の「placeholder」の記述は古くなる。notes を直すか、`status` を変えるかは契約の変更で、この草稿の範囲外（実装 PR の本文に「契約は変えない。notes が古くなる」と書く、という扱いを案とする）。
  - 一方、コード側には `semantic-index` を扱う箇所がある（`nir1_graph_index_maintenance.rs:73` の定数と、:362-366 が `narrative_consumer_freshness` からこの種類の行を**読む**クエリ）。**この種類の行が実際に書かれて Inbox に載るか、`reserved` との関係は、書き込み側を追っていないので未確認**。
- `evidence_freshness` は `fresh`／`stale`／`source-missing`／`anchor-mismatch`／`read-set-drift`／`unknown`（`evaluator.rs:35-44`、kebab-case）。terminal failure の行は `None`。

### 1.3 renderer の呼び手と wrapper の置き場【確認済み】

- `narrative_maintenance_inbox_list`／`narrativeMaintenanceInboxList` を呼ぶ **src/ のコードは 0 件**。呼んでいるのは journey の script（`electron/scripts/narrative-maintenance-product-journeys.mjs:3239`、`electron/scripts/c2zc-canonical-product-journey.mjs:2991`、`scripts/c2zc-product-journeys.test.mjs`）と、main の制限 profile の経路の試験だけ（`electron/main/d2aOwnDataRead.pipeline.spec.ts:533-537`）。
- renderer が呼ぶ wrapper の置き場は、**`src/application/narrative-extraction/nativeApi.ts`**（`invoke` は `@/lib/tauri` から。同じ file の `narrativeExtractionListSceneProposals` が `:1055`、試験は同じ階層の `nativeApi.sceneProposals.test.ts`）。AGENTS.md は「renderer は `src/lib/` の wrapper 経由で `window.grimodex` を利用する」と書く。起案者の読みでは、この `src/lib/` は `invoke` の層（`@/lib/tauri`）を指し、feature 向けの command ごとの wrapper は `src/application/…` に置く現状（AGENTS.md が command ごとの wrapper の置き場まで定めているかは未確認）。
- feature 側がこの file を**実行時に** import する前例は多い（`src/features/codex/codexStructureExtractionApi.ts:70-77`、`src/features/chronicle/chronicleExtractionApi.ts:36-47`、`src/features/narrative-semantic-core/nir1EntityRelationRevisionApi.ts:2-6` が関数を import している。`chronicleExtractionStore.ts:13-17` と `ChronicleExtractDialog.tsx:40` は `import type` だけで、前例としては弱い）。一方、`src/features/narrative-extraction/runtime/narrativeRuntimePolicyApi.ts` のように feature 内に置く前例もある。
- **`validate:architecture` の向きの規則との適合は、規則を読んで確かめた（実行は未実施）**。`scripts/validate-architecture.mjs:961-970` の findings は、store どうしの import（`cross-feature-store-import`）、application から `.tsx` への import（`application-component-import`、:1009-1029 付近）、`feature-cycle`（runtime import のグラフ）などで、**feature から application への実行時の import を止める規則は見当たらない**。`nativeApi.ts` が features から import するのは `import type` だけ（:7-19）で、runtime import の循環も起きない見込み。`nativeApi.ts` は `policies/architecture/large-module-debt.json` にも載っていない。したがって、wrapper を `src/application/narrative-extraction/nativeApi.ts` に足す案は、静的な読みでは通る見込み（`validate:architecture` の実際の実行は未確認。§7.3-7）。
- `ForeshadowPanel.tsx` の mount は、policy が許すときだけボタンを出し（:438-452）、押すと `StructureHealthPanel` を mount する（`{structureHealthOpen && <StructureHealthPanel … />}`：:465-467）。つまり **panel の mount ＝ 開いた時**で、`useEffect` で 1 回読めば「開いたときに 1 回だけ」になる。
- `StructureHealthPanel` は `onClose` だけを props に持つ（:4-6）。`projectId` は持たない。

### 1.4 登録済みの規則と、計画だけの規則【確認済み】

- `policies/narrative/narrative-finding-contract.json` に登録済みの規則は 2 つ。`narrative.consumer-freshness`（v1、edge 単位）と `narrative.maintenance-contract-failure`（v2、maintenance-work 単位、durable）。理由コードは 11 種（source-revision-changed、source-missing、evidence-overlap、context-overlap、exact-content-relocated、quote-not-found、quote-ambiguous、read-set-drift、normalizer-incompatible、component-incompatible、target-modified）。
- roadmap の「Foundation rules」7 つ（`evidence-stale`、`source-missing`、`anchor-mismatch`、`read-set-drift`、`stale-projection`、`dependency-contract-error`、`semantic-index-dirty`：:638-646）は、上の登録済み 2 規則と理由コードとは**別の物差し**で、1 対 1 には対応しない。この草稿は Foundation rules の名前を画面や型に使わない。
- roadmap の feature rules 6 つ（`source-unseen`、`zero-mentions`、`ambiguous-identity`、`unsupported-relation`、`generic-surface`、`correction-conflict`：:648-657）は、**計画だけ**。6 つの名前を `src`・`src-tauri/crates`・`electron`・`policies`・`docs` で文字列検索した結果、`ambiguous-identity` だけが `src/features/work-layer/workLayerFixture.ts:27,52` と `WorkLayer.test.tsx:44,69` に出た（fixture の `kind` と表示文字列で、規則の実装・登録ではない）。ほかの 5 つは roadmap と本草稿以外に出なかった。規則の登録の仕組みを別の名前で探すことまでは、していない。
- `StructureHealthPanel` は `buildStructureHealthPreview()` の固定値（`phase: "foundation-only"`、`liveCountsAvailable: false`）で動いている（`structureHealthModel.ts:1-21`）。試験は、この固定値を `toEqual` で固定している（`structureHealthModel.test.ts:5-13`）。

### 1.5 ボタンが出る条件【確認済み、一部未確認】

- ボタンは `isNarrativeMaintenanceUiEnabled(policy)`（`src/features/narrative-extraction/maintenance/maintenanceFlags.ts:11-18`）が true のときだけ出る。条件は `maintenancePreviewAllowed === true` かつ `effectiveMode !== "disabled"`。`policy` は `ForeshadowPanel.tsx:398-412` が `getNarrativeRuntimePolicy()`（`runtime/narrativeRuntimePolicyApi.ts:69-72`。`narrative_runtime_policy_get` を呼ぶ）で取る **Native の値**で、読めない・不正なら閉じる（`structureHealthEnabled = false`）。
- **許可の置き場は Native の `narrative_runtime_policy` 表（singleton）**で、`app_settings` ではない。書けるのは typed の Native setter だけで、renderer の SQL からは書けない（`src-tauri/crates/grimodex-db/src/narrative_runtime_policy.rs:3-6`）。IPC は `narrative_runtime_policy_set`（`electron/shared/ipcContract.ts:553`、検証 :1743-、`NAPI_COMMANDS` の定義 :8947-）で、payload は `expectedVersion`・`runtimeMode`・`maintenanceEnabled`・`genericImportEnabled`・`backgroundAiEnabled` の 5 つ全部が要る（:1744-1760 付近）。
- `maintenancePreviewAllowed` は Native が `maintenance_enabled` などから算出する（`narrative_runtime_policy.rs:141-149`）。**実際のスイッチは表の列 `narrative_runtime_policy.maintenance_enabled`** で、**既定は `false`**（:101、表の定義 :262）。
- **旧い設定 key `narrative.maintenanceEnabled`（`app_settings`）は、スイッチではない**。`narrative_runtime_policy.rs:27-29` が「Pre-Foundation shadow keys. Never promoted into Native authority」と書き、`delete_legacy_app_settings_shadow_keys`（:234-253）が、Native が昇格させずに**消す**。`src/features/narrative-extraction/runtime/narrativeRuntimePolicy.ts:17-24` の `NARRATIVE_RUNTIME_SETTING_KEYS` は `@deprecated` で、ボタンの判定には使われない。この草稿の前の版は、この旧い key を「ボタンを出す設定」と書いていたが誤り（独立レビュー M1 で訂正）。実装する人が直すのは**Native の runtime policy（`narrative_runtime_policy_set`）**。
- 作者がこの許可を ON にする画面は、src/ の非試験コードに**確認できなかった**：`narrative_runtime_policy_set`／`narrativeRuntimePolicySet` を呼ぶ wrapper・画面は無く、`narrativeRuntimePolicyApi.ts` の wrapper は get だけ。electron の main／preload の非試験コードにも呼び手は無く、呼んでいるのは `electron/main/codexStructureExtraction.pipeline.spec.ts:404` などの試験だけ。**検索の範囲：src/・electron/main・electron/preload の非試験コード。MCP や環境変数などの別経路は未確認**。
- `narrative_maintenance_inbox_list` の N-API（`lib.rs:16325-16340`）と `build_maintenance_inbox` には、この policy の検査が**見当たらない**。**読んだこの 2 か所には検査が無い**。`with_db_state`（`src-tauri/crates/grimodex-db/src/state.rs:585-`）にも policy の検査は無い（関数は DB を開いて `f` を呼ぶだけ）。main の dispatch など、さらに前の層に検査があるかは未確認。一方、`maintenanceFlags.ts:9` のコメントは「Native `require_narrative_maintenance_allowed` remains authoritative」と書くが、**inbox の N-API はその関数を呼ばない**。この非対称（renderer のボタンの出し分けは Native の値を見るが、読み取りの経路は検査しない）は、仕様として残す：読んだ範囲では、gate は renderer のボタンの出し分けだけに見える。最初の版が「`maintenancePreviewAllowed` が false のときは呼ばない」を守るのは panel の仕様であって、Native が強制する仕組みではない。Native に検査を足すかは、別の判断（新しい契約になりうるので、この草稿の範囲外）。
- `maintenance_enabled` は `maintenance_preview_allowed` の前提で、`maintenance_mutation_allowed` もそれを前提にしている（`narrative_runtime_policy.rs:141-153`）。同じ設定が保守の他の許可にも使われるので、**「数字を見せるためだけに既定を ON にする」ことは、保守の他の動作にも影響する見込み**（影響の範囲は今回追っていない【未確認】）。これが問い P3 を別の問いにしている理由。

## 2. 方針

1. 読み取り専用。**保存・変更・修復の呼び出しは持たない**（Hold／Dismiss／Revalidate などの Inbox actions は、roadmap :659-669 にあるが、最初の版に入れない）。
2. 最初の版（件数だけ）が呼ぶ IPC は既存の `narrative_maintenance_inbox_list` だけ（新しい IPC を足さない前提は最初の版に限る。§5）。引数は `{ payload: { projectId } }`。
3. 呼ぶのは**モーダルを開いたとき 1 回**（最初の版。場面へ飛ぶ版の読み取りは別の PR の設計で、§5）。再読込のポーリング・イベント購読・タイマーは持たない。閉じて開けば、もう 1 回読む。
4. 既定で閉じている。ボタンの出し分け（`maintenancePreviewAllowed`）は今のまま変えない。mount 時に走らせない（`ForeshadowPanel` 自体の mount では呼ばない）。
5. 通知もバッジも出さない。ボタンの見た目・ラベルに件数を足さない（ADR 014 の「守ること」5 の「変わるのは件数だけ」を、サイドペインでない今回の面にも**準用**する。準用であって、同じ規定がこの面に直接及ぶわけではない）。
6. 自動では何も直さない。数字は「そのときの状態を数えたもの」で、真偽の判定ではない。`stale` は撤回ではない（`evaluator.rs:33-34` の説明に沿う）。
7. 提案を作業（Task）に変えるボタンは付けない（ADR 012:85「Finding／Attention は観測・判断候補であって、作者が引き受けた WorkTask ではない」、Invariants の 4）。

## 3. 数える定義

Inbox の 1 行は **Consumer 1 つ**（`finding_key = "{consumer_kind}:{consumer_key}"`）。1 つの提案に複数の根拠があっても、Consumer としては 1 行にまとまる。したがって**数は「提案の版の数」であって、場面の数でも本文の箇所の数でもない**。

### 3.1 最初の版で出せる数

| 見出し（案。文言は問い P4 の回答待ち） | 定義 | 出所 |
| ------------ | ---- | ---- |
| 根拠が古くなった提案（合計） | `entry_kind == "consumer-freshness"` かつ `consumer_kind == "proposal-revision"` かつ `evidence_freshness != "fresh"` | Inbox の行 |
| 　内訳 | `evidence_freshness` の値ごと：`stale`（本文が変わった）、`source-missing`（根拠が見つからない）、`anchor-mismatch`（根拠の位置が合わない）、`read-set-drift`（読んだ範囲が変わった）、`unknown`（判定できない） | 同上 |
| 点検した提案の総数（分母） | `consumer_kind == "proposal-revision"` の行の数（fresh を含む） | 同上 |
| 保守が止まった記録 | `entry_kind == "terminal-failure"` の行の数（問い P5。別行で出すのが推奨） | 同上 |

- 画面の語は作者の言葉にする。ADR 014 の「守ること」4（`docs/adr/014-scene-information-in-editor.md:104`）が画面に出さないと挙げる語は「NIR」「IR」「Revision」だけで、**「Consumer」「Freshness」「Edge」は起案者が足した案**（実装の語を作者に見せない、という意図。ユーザーの決定ではない）。内訳の見出しの文言は、**案**であって確定ではない（問い P4 の回答待ち。ja／en の文言は実装時に、回答を受けて決める）。内訳の意味づけ（たとえば `stale`＝「根拠の本文が変わった」。この語を使うのは `stale` の内訳だけ）は、`evaluator.rs:33-34` の説明と理由コードからの**起案者の読み**で、画面に出す前にユーザーの確認を求める（問い P4）。
- 内訳にするのは、`!= fresh` を一括で「本文の変更」と呼ぶと、`source-missing` や `unknown` まで「本文が変わった」と読ませてしまうため。
- 色だけで区別しない（ADR 014 の「守ること」1）。見出しは文字で、件数は数字で出す。

### 3.2 出さない数、混ぜない数

- **`semantic-index`（Graph／ER の索引の dirty）の行は、最初の版の「提案」の数に混ぜない**。同じ表（`narrative_consumer_freshness`）に載る場合は、`consumer_kind` で絞らないと提案の数に入ってしまう（載るかは §1.2 のとおり未確認）。索引の状態を別の行で見せるかは、最初の版には入れない案（推奨。ユーザーの確認待ち）。
- `narrative-extraction-run`・`application` の行も、最初の版の見出しには出さない。出すなら別の問いにする。
- **feature rules の件数は出ない**（`source-unseen`、`zero-mentions`、`ambiguous-identity`、`unsupported-relation`、`generic-surface`、`correction-conflict`）。実装が無いため。`ambiguous-identity`・`correction-conflict` は ERM（同定の訂正規則）が前提という起案者の読みで、ERM は同定の review の負荷を先に測る（2026-11-23 の決定③）。入れる時期は決まっていない。画面で「まだ点検しない項目」の一覧を出さない案（推奨。出すと、できていない点検を約束するように読める。画面の見せ方はユーザーの確認待ちで、問い P7 と一緒に伺う）。

### 3.3 場面ごとの一覧とは数え方が一致しない【確認済み、数の差の大きさは未確認】

- 場面ごとの提案の一覧（`narrative_extraction_list_scene_proposals`）は、現在の版だけ（`p.current_revision_id = r.id`）、年表の事象の提案だけ（`p.kind = ?4`）、その場面を根拠に持つものだけ、に絞っている（`scene_proposals.rs:70-89` の SQL）。
- Inbox にはこの絞りが**無い**。置き換わった古い版、承認・却下済みの提案、年表以外の種類の提案の行が数に入るかは、書き込み側（`publish_runtime` など）の挙動に依存し、**今回は確かめていない**。`InboxEntry` には提案の確認状態（承認済み／却下済みなど）も入っていないので、「確認待ちの提案」とは言えない。見出しに「確認待ちの提案」は使えない。案は「根拠が古くなった提案」（確認の状態を問わない。問い P4 の回答待ち）。
- ADR 014 の Consequences は「Work Layer を実データにつなぐとき、件数の数え方と、場面へ飛ぶ入口を、統合ペインと共通にする」（`docs/adr/014-scene-information-in-editor.md:136`）としている。**今回の数と、場面ごとの一覧の数は一致する保証がない**。2 つが同じ画面に並ぶ前に、数え方を揃えるか、違うものと明示するかが要る（問い P2 の B 案に直結）。
- 作者の保留（dismissed／flagged）は、行として返る。数に**含める**（隠れるのは有効な snooze だけ）。実際に付く経路が renderer に無いので、最初の版では実質的に影響しない見込み【未確認】。

### 3.4 本番のデータにどれだけ入るか【未確認】

- Freshness の行を書く経路（`incremental_freshness.rs`、`restore_rebuild.rs`、`repository.rs`）が配線されていることは調査 agent の報告で、今回は書き込み側を追っていない。実際の project で行がどれだけ入るかは**未測定**。
- 大きい project での応答時間は**未測定**。構造の事実として、上限・ページ送りが無く、Consumer の行ごとに観測と保留の読み出しがある（§1.1）。測定の方法は実装の前に決める。応答が遅い場合は、読み込み中の表示を出し、本文の入力を止めない（呼ぶのは開いたときだけで、本文の編集とは別の経路）。

## 4. 置き場の選択肢と、ADR との整合

| 案 | 内容 | 利点 | 衝突・難点 |
| -- | ---- | ---- | ---------- |
| A 伏線パネルの「健全性」ボタンから開くモーダル（推奨。名前の改め方は問い P7） | 今のモーダルに数字を出す | すでにボタンと mount がある。新しい常駐領域を作らない。`ForeshadowPanel.tsx` の差分を 0 にできる（下） | 伏線と関係のない「提案の鮮度」が伏線パネルにある不自然さ。作者に見える入口は伏線パネルのヘッダーだけ |
| B 作業の層（Work Layer） | 作品全体の件数と入口を、Task Tray 側に出す | ADR 014 D6（`:78-83`）の「作品全体の件数と入口は Work Layer が持つ」に沿う | Work Layer は fixture・prototype 専用で、実データの hook が無い（【確認済み】`useWorkLayerPreviewPort` は「development かつ fixture の flag が `"true"` かつ面が有効」のときだけ有効で、production は fixture の chunk を import しない：`useWorkLayerPreviewPort.ts:11-25`。`workLayerFixture.ts` は固定データ）。実データへの配線の設計が要り、最小ではない |
| C エディタのサイドペイン | 今の場面の件数として出す | ADR 014 D7 の「文脈」タブに近い | Inbox は project 全体で、場面に結ばない（§5）。場面単位の数にできない。ADR 014 D10（:97）は、公開前に足すのを「この場面の解釈」の節だけに限る |

### 4.1 ADR との整合

- **ADR 012**：Finding／Attention は WorkTask ではない（:85、Invariants の 4＝:253）。常駐領域を増やさない（Invariants の 9＝:258、決定 3 の :113-117）。案 A は、開いたときだけ出るモーダルで、常駐しない。案 B・C は設計が要る。
- **ADR 014**：「文脈」は開くまで読み込まない（D7＝:89、D10＝:97）。提案が届いても自動で開かない・通知しない・フォーカスを動かさない（守ること 5＝:105）。これらは、直接にはエディタのサイドペインの規定。案 A のモーダルは、同じ向き（開くまで読まない・通知しない）に**準用**する。D6 が「解釈の状況の画面は新しい画面にせず Work Layer に吸収する」（:82）と述べるので、**推奨（問い P1 の回答待ち）は、案 A を最初の版の置き場、本来の置き場を B とする二段の整理**。移設をやるか・いつやるかは決まっていない（ユーザーの確認待ち。実データへの配線の設計ができてから、が推奨。§7.2）。
- 本草稿は、新しい画面・パネル・領域を足さない。レイアウトの変更もしない。

### 4.2 `ForeshadowPanel.tsx` に触らない最小の形【FSR/1 との衝突を避ける】

- 変更するのは `StructureHealthPanel.tsx`、`structureHealthModel.ts`、wrapper（`nativeApi.ts`）、locale の `narrativeMaintenance` ブロック内のキーだけ。
- panel は props を増やさず、自分で現在の project を取る。ForeshadowPanel が使う `getCurrentProjectId()`（`currentProjectAuthority.ts:15-17`）は、読込み前に `"default-project"` を返すので、**`getLoadedProjectId()`（:20-22）が `null` のときは呼ばない**。これで ForeshadowPanel の mount を変えずに済む。
- ボタンの testid（`structure-health-preview-button`）と、ForeshadowPanel 側のコード内の既定文言（`"構造の健全性（プレビュー）"`・`"健全性"`：:445-449）は残る。locale の値を変えれば画面の文言は変わるが、locale が欠けたときの既定文言は古い「プレビュー」のままになる。
- grimodex-23 の FSR/1 が `ForeshadowPanel.tsx` を触る、という衝突は、**この worktree の docs からは裏が取れていない**。調査 agent の報告（handoff の記述）として扱う【未確認】。

## 5. 場面へ飛べない件

- `InboxEntry` に `sceneId` が無い（§1.2）。提案の版から場面への逆引きは、今の読み取りには無い。場面ごとの一覧は `sceneId` が必須で、project 全体の逆引きではない（`ListSceneProposalsPayload`：`scene_proposals.rs:94-`）。
- 参考：場面の一覧は `narrative_dependency_edges` の `source_object_identity`（`project:scene:…`）で場面に結んでいる（`scene_proposals.rs:65`、:78、:394）。つまり、提案の版と場面を結ぶ材料は DB 側にある。ただし **Inbox の読み取りを広げて場面を返すのは新しい契約**（戻りの型の変更）で、この草稿の範囲外。

| 選択肢 | 内容 | 帰結 |
| ------ | ---- | ---- |
| A（推奨） | 最初の版は件数だけ。場面へは飛ばない | 新しい契約が要らない。作者は「何件ある」までしか分からず、**どの場面かは分からない**。この画面（今の名前は「健全性」、改名案は「構造の点検」）の価値は限定的で、見るだけの画面になる |
| B | 場面に結ぶ読み取りを別 PR で足す | 場面へ飛べる。新しい読み取りは、own-data-read の台帳（`profileEgress.ts:177-226`）に足すなら**新しい draftRef が要る**（同 :173 のコメント「adding or removing a command here needs a new draftRef」）。数え方を場面ごとの一覧と揃える作業も同時に必要（§3.3） |
| C（取らない） | 場面ごとに `list_scene_proposals` を N 回呼んで集計する | 新しい IPC は要らないが、場面の数だけ呼ぶので重い。年表以外の提案を取りこぼす。「開いたとき 1 回だけ」の精神に反する |

**2026-11-23 の回答（問い P2）**：場面へも飛べるようにする。最初の版は A（件数だけ）で、続く別の PR で B の方向（場面に結ぶ読み取り）を足す。したがって、「新しい IPC は足さない」という最小実装の前提（一枚目・§2）は、**最初の版（件数だけ）に限る**。

**設計の宿題（未設計）**：場面へ飛ぶための読み取りを、(1) 新しい IPC として足すか、(2) 既存の読み取り（`narrative_maintenance_inbox_list`）の戻りを拡張するか。どちらも `electron/shared/ipcContract.ts` に触れうる（今の Inbox の検証は :1870-1885、契約の宣言は :1244）。どちらを選ぶかは決めていない。いずれにせよ新しい契約になりうるので（上の B の帰結）、設計の後にその点を改めて扱う。衝突しうる file（現時点の見込み。確かめていない）：`electron/shared/ipcContract.ts`（他の lane の IPC 追加と同じ file）、`electron/native/grimodex-node/src/lib.rs` と `index.d.ts`（N-API の追加・変更）、`src-tauri/crates/grimodex-db/src/narrative_extraction/inbox_read_model.rs`（(2) の場合）、own-data-read の台帳 `profileEgress.ts`（新しい draftRef が要る）、`src/application/narrative-extraction/nativeApi.ts`、locale の `narrativeMaintenance` ブロック。数え方を場面ごとの一覧と揃える作業も同時に要る（§3.3）。

（以下は回答の前の記述）ユーザーの確認待ち（問い P2）。A を選ぶなら、画面の文言で「場面は、各場面の提案の一覧で確かめられます」のように、**今ある別の入口を案内するか、何も案内しない**かを、実装の前に決める。

## 6. 実装の変更 file の案、試験、i18n、mock

実装は、この草稿の確認の後。以下は案で、技術判断は委任の範囲。

### 6.1 変更する file

| file | 変更 |
| ---- | ---- |
| `src/application/narrative-extraction/nativeApi.ts` | `narrativeMaintenanceInboxList({ projectId })` と、検証して camelCase に写した型を追加（§1.2） |
| `src/features/narrative-extraction/maintenance-ui/structureHealthModel.ts` | `summarizeInbox(entries)`（種類で絞って数える純関数）を追加。固定の preview 関数は残す／消すを実装で決める |
| `src/features/narrative-extraction/maintenance-ui/StructureHealthPanel.tsx` | mount 時に `useEffect` で 1 回取得。読込み中・失敗・件数・0 件の 4 つの表示。取り消しの flag（`ForeshadowPanel.tsx:399-411` の `cancelled` と同じ形）で、閉じた後の応答を捨てる |
| `src/locales/ja.json`・`src/locales/en.json` | **`narrativeMaintenance` ブロックの中だけ**（ja:6543-、en:6568-）。他の lane の ja／en の編集が近い行にあると merge conflict になりうるので、ブロックの外や末尾には足さない |
| 試験 file（新規） | `nativeApi.maintenanceInbox.test.ts`、`StructureHealthPanel.test.tsx` |
| 試験 file（更新） | `structureHealthModel.test.ts`（固定値の `toEqual` が、新しい挙動に合わせて変わる） |

- 現行の文言（`previewNote`「…依存関係Indexの配線後に実数へ切り替わります…」、`foundationOnly`「Change Feedの基盤だけが有効です。…」）は、実数を出すなら**嘘になる**ので、ja／en とも改める。`modeLabel` と `health.*` の 6 キーは、src/ に使い手が見つからない既存の未使用キー（検索の範囲：src/・scripts/・electron/）。消すかは実装で決める（この草稿は触らない）。他に、これらの locale キーを参照する file は確認できなかった。
- panel の見出し「構造の健全性」と「プレビュー」の表示は、問い P1・P7 の回答の後に、「構造の点検」へ改めるかを決める（今の名前は「健全性」で、「構造の点検」は改名の案）。件数が出るようになった後も「プレビュー」を残すかは、feature rules が無い間は「一部の点検だけ」と画面に明示する案（推奨）。

### 6.2 試験

- **happy-dom で足りる見込み**。モーダルの枠（`fixed inset-0 z-50`、`max-w-lg`、`max-h-[90vh] overflow-auto`）の位置・寸法を変えず、件数の行を足すだけなら、CLAUDE.md の「レイアウトの検証」（位置・寸法・ヒット領域の修正や、CenterStripe／RegionStripe／Splitter／LayoutShell のレイアウト変更では実 Chromium の `pnpm test:browser`）に当たらない。panel は件数の集計だけで、Inbox の行を並べない（行の一覧を出すなら、スクロールと高さが変わるので、実 Chromium の幾何の試験を足す。その場合は `layoutInvariants.browser.test.tsx` の形に倣う）。
- 試験の内容（案）：wrapper が、検証して camelCase に写すこと（snake_case の入力、未知の `evidence_freshness`、欠けた field）。`summarizeInbox` が種類で絞り、内訳が合計と合うこと。panel が、**閉じている間は呼ばれない**こと、開いたとき 1 回だけ呼ばれること、読み込みに失敗したとき、数えられなかった旨の文言を表示すること、空配列のとき「点検の対象がまだありません」を表示すること、`getLoadedProjectId()` が `null` のとき呼ばないこと。`ForeshadowPanel` 側の既存の試験に、健全性ボタンを対象にした試験は、調べた範囲では存在しない。
- 実際の wire の形（§1.2）は、Rust 側の試験か、実 Native を通す journey で一度観測して固定する（案。実行はこの草稿の範囲外）。

### 6.3 browser-mock

- `src/lib/browser-mock.ts` には、inbox の command の case が**無い**。主の `invoke`（:28112-）の `default` が `[browser-mock] Unknown Tauri command: …` を throw する（:28823-28824）【確認済み】。
- 同じ mock に `narrative_runtime_policy_get` の case も**無い**（grep で 0 件）。ボタンを出すかを決める `getNarrativeRuntimePolicy()` が mock では失敗し、ForeshadowPanel の `catch` が `structureHealthEnabled = false` にするので（:398-412）、**mock の上ではボタン自体が出ず、panel は開かない**見込み【実際に mock で開いた確認は未実施】。したがって、panel の失敗の表示は主に実 Native の失敗用で、mock は足さなくてよい見込み。画面の確認のために mock を足すかは、実装の時に決める。

### 6.4 制限 profile・admission【一部未確認】

- 制限 profile の admission で `narrative_maintenance_inbox_list` が閉じられるか：コードの分類は確認した。`OWN_DATA_READ_COMMANDS`（`profileEgress.ts:177-226`）に入っていて、`NIR1_PUBLICATION_COMMANDS`（:247-257）には入っていない。`D2A_OWN_DATA_READ_OPEN = true`（:48）で、分類は :743-745。台帳の側の試験（`d2aRouteClasses.test.ts:123`）と、制限 profile の経路の試験（`d2aOwnDataRead.pipeline.spec.ts:533-537`）にも入っている。**実際に制限 profile で通ることは、これらの試験を今回実行していないので未確認**。
- 戻りの型（§1.2）には、場面の本文や提案の文面にあたる field は無い。含まれるのは、`InboxEntry` の id 系・種類・状態（`consumer_kind`、`consumer_key`、`evidence_freshness`、`build_action`、`finding_key`）と、`FindingObservationRow`（`finding_observation.rs:47-72`：`run_id`・`semantic_epoch_id`・`edge_id`・`finding_identity`・`rule_id`・`reason_code`・`failure_code`・`observation_digest`・`material_basis_digest`・`observed_at` など）、`AttentionRow`（`attention.rs:119-144`）。**ただし `AttentionRow` には、作者が書く自由文の `reason: Option<String>`（:144）と、判断した人の識別 `actor_id`（:136）、要求の識別 `request_id`（:142）、`payload_digest` が載る**。「場面の本文を含まない」は成り立つが、「作者が書いた文字が一切入らない」とは言えない。
- 案（推奨。ユーザーの確認待ちではなく、起案者の技術判断。保存・送信の範囲を広げない方向）：最初の版の画面と wrapper は、これらの自由文・識別 field（`reason`・`actor_id`・`request_id`・`payload_digest`）を**読まず、表示せず、保存せず、log に出さない**。wrapper は検証して camelCase に写すとき、数に要る field（`entry_kind`・`consumer_kind`・`evidence_freshness`）だけを写す allow-list にする。読み取りの契約（戻りの型）は変えない（変えるのは新しい契約）ので、`reason` が wire に載ること自体は残る。実装 PR の本文に、この点（自由文の field が wire に載るが、最初の版は使わない）を書き、K3/2 の判断の材料にする。
- **この読み取りが NIR の平文の公開にあたらないかの最終判断は、K3/2 の台帳の側で行うもの**で、草稿は「型の定義の上では、場面の本文や提案の文面を含まない。作者の自由文 `reason` は含みうる」までしか言わない。
- 数を出す経路は renderer の表示だけで、AI・外部・保存へは流れない。

## 7. 受入れ条件、最初の版に入れないもの、未確認

### 7.1 最初の版の受入れ条件（案）

1. モーダルを開いたとき 1 回だけ `narrative_maintenance_inbox_list` を呼ぶ。閉じている間・ボタンが出ていない間・`ForeshadowPanel` の mount 時には呼ばない。
2. 数字は Inbox の行から出す。固定値・placeholder を出さない。
3. 読み取り専用。保存・IPC の新設（最初の版に限る。場面へ飛ぶ読み取りは別の PR。§5）・修復の操作・通知・バッジ・自動で開く動作が無い。
4. 0 件の文言が「正常」と読めない。失敗の文言が、0 件と区別できる。
5. `ForeshadowPanel.tsx` に差分が無い。locale の変更は `narrativeMaintenance` ブロック内だけ。
6. 画面の語に、NIR・IR・Revision（ADR 014 の「守ること」4）と、起案者が足した Consumer・Freshness・Edge を出さない。色だけで意味を分けない。
7. 「Exit criteria」への対応を、PR の本文に明記する：:673 の 1 つ目（実際の件数は正本から）の**一部だけ**を満たす。2 つ目（「Source の編集で、影響のある Finding だけが更新される」）、3 つ目（人の判断が、harmless な再評価を越えて残る）、4 つ目（自動の警告が、出所と理由を述べる）は**満たさない**。P0-B の完了とは書かない。

### 7.2 最初の版に入れないもの（入れる時期は未確認。いずれも推奨で、ユーザーの確認待ち）

- feature rules 6 つ（§3.2）。`ambiguous-identity`・`correction-conflict` は、ERM（先に review の負荷を測る）の判断の後という読み。
- Work Layer への移設（ADR 014 の Consequences、:136）：**推奨（問い P1 の回答待ち）。やるか・いつやるかは決まっていない**。やるときは、場面へ飛ぶ入口と数え方を、統合ペインと共通にする。
- Inbox actions（Hold・Dismiss・再検証・場面へ飛ぶ、など：roadmap :659-669）。場面へ飛ぶ入口は、P2 の回答（2026-11-23）で「場面へも飛べるように」と決まったが、最初の版には入れず、場面に結ぶ読み取りを別の PR で足す（未設計。§5）。
- `semantic-index` など、提案以外の行の見せ方。
- 既定で見せるか（問い P3）。保守の他の動作まで開くため、別の判断。

### 7.3 未確認の一覧

1. wire のキーが snake_case であることの実際の観測（§1.2）。
2. Inbox の行に、置き換わった古い版・承認／却下済みの提案・年表以外の提案が含まれるか。場面ごとの一覧との数の差の大きさ（§3.3）。
3. 実際の project で、Freshness の行がどれだけ入るか。大きい project での件数・応答時間（§3.4）。
4. `semantic-index` の行が実際に書かれて Inbox に載るか、契約の `reserved` との関係（§1.2、§3.2）。
4b. main の dispatch など、`with_db_state`（検査は無いと読んだ）以外の層に policy の検査があるか（§1.5）。
5. Native の runtime policy（`narrative_runtime_policy_set`）で `maintenance_enabled` を作者が ON にする画面・経路の有無（src/・electron/main・electron/preload の非試験コードの検索では確認できなかった。MCP や環境変数などの別経路は未確認。§1.5）。
6. 制限 profile で実際に通ること（試験は存在するが実行していない。§6.4）。
7. `validate:architecture` の**実行**での確認（規則の静的な読みでは、feature から `src/application/…/nativeApi.ts` を import する向きは止まらない見込み。§1.3）。新しい wrapper を feature 内に置くか application に置くかは、実装の時の技術判断（委任の範囲）。
8. mock で panel が開かないことの実際の確認（§6.3）。
9. Work Layer に実データの hook が無いこと（調査 agent の報告、個別の再確認なし。§4）。
10. FSR/1 と `ForeshadowPanel.tsx` の衝突（この worktree の docs からは裏が取れない。§4.2）。
11. 有効な snooze が実際に付く経路（renderer の呼び手が無いため、隠れる行は実質無い見込み。§1.1、§3.3）。

この草稿では、build・重い test・`pnpm install`・`gh`・network は使っていない。コードと既存 docs は変更していない。

## 8. その後に確かめたこと（2026-11-25 追記。§1〜§7 の本文は書いた時点のまま）

### 8.1 実装の状態と、2026-11-25 の回答

- 最初の版（件数だけ。作者には見えないまま）は #1042 で merge 済み（DR-M3-14）。その後、ヘッダーの Work Layer 向けに件数だけの読み取り（#1110、DR-M3-31）と、live の行（#1114、DR-M3-32）が入った。「根拠が古くなった提案」の行は、保守機能の許可が入っている作品でだけ出る。許可は既定で切れているので、既定では作者に見えない。
- ユーザーの回答（構造化質問）：「根拠が古くなった提案」の行と「健全性」のボタンは**作者に見えないまま**にし、下の部分（試験や読み取りの設計）だけ進める。次の作業は**場面へ飛ぶ読み取りの設計草稿**で、新しい契約になるので実装の前にもう一度伺う。記録は contracts の M3 の確認記録の追記 30。

### 8.2 §7.3 の未確認の項目

| §7.3 の番号 | 今 | 根拠（`origin/master` `dd014db91`） |
| ---- | ---- | ---- |
| 1（wire のキー） | **未確認のまま**。直列化の定義では snake_case だが、Native の実際の戻り値を assert する試験は確認できていない | `inbox_read_model.rs` の `InboxEntry`、N-API の `serde_json::to_string` |
| 3（行数と応答時間） | 一部：合成の DB で Inbox の構築の時間を測った。実在の project の行数は読んでいない（回答により読まない） | DR-M3-31 |
| 5（許可を ON にする経路） | 作者向けの画面も renderer の setter も無い（renderer は get だけ）。IPC の setter はあり、品質評価の setup driver が ON にしている | `narrativeRuntimePolicyApi.ts`、`ipcContract.ts` の `narrative_runtime_policy_set`、`scripts/quality/nir1-graph-eval/setup-driver.mjs` |
| 6（制限 profile） | 呼び出しを含む試験がある（今の設定では、制限なしと同じ結果になることを assert） | `electron/main/d2aOwnDataRead.pipeline.spec.ts` |
| 7（`validate:architecture`） | 解消：CI の静的検査の job に含まれ、#1042 はその job が成功した | `.github/workflows/ci.yml` の `frontend-static`。#1042 の PR の checks でこの job は成功 |
| 8（mock でボタンが出ない） | 変わらず（固定する試験は確認できていない） | `browser-mock.ts`、`ForeshadowPanel.tsx` |
| 9（Work Layer の実データ） | 解消：live の読み口が入った | #1114、`workLayerLiveReaders.ts` |
| 10（FSR/1 との衝突） | #1042 は `ForeshadowPanel.tsx` を変えずに merge した | #1042 の変更 file |
| 11（snooze が付く経路） | Native の command はあるが、renderer の呼び手は無い。MCP と自動の保守から呼ぶ経路は、検索の範囲では見つかっていない | `narrative_maintenance_attention_set` |
| 2・4 | 未確認のまま | — |

### 8.3 roadmap の Exit criteria の今

| Exit criteria | 今 |
| ---- | ---- |
| 件数は正本の Consumer Freshness と Finding の identity から | 一部：伏線パネルの画面と、ヘッダーの件数が正本から読む |
| 場面の編集で、影響のある Finding だけが更新される | **そのまま固定する試験は確認できていない**（依存しない側が変わらないことの assert が無い） |
| 人の処分は、影響の無い再評価を越えて残り、根拠が実質的に変われば戻る | **再評価をまたぐ試験は確認できていない**。snooze は、新しい観測を試験内で差し替えて Inbox に戻ることを assert する試験がある |
| 自動の警告は、出所と理由を述べる | 未対応（画面は件数だけ） |

2 つ目と 3 つ目は、2026-11-25 の read-only の調査（試験は実行していない）の結果。試験を足すのは別の PR にする。
