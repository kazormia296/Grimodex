> 注（integrator、2026-11-03）：read-only の workflow（調査 2・計画 1。model は sonnet）の実装計画の案。integrator が確かめたのは、harness が launch のたびに `GRIMODEX_PRODUCT_JOURNEY_FAKE_AI` を立てること（`electron/scripts/product-journey-harness.mjs:5240`）と、key の保管が basic_text／unknown の backend を拒むこと（`electron/main/keyStore.ts:193-194`）。何も実行していない。key の渡し方は未決（ユーザーに確認する）。

# 段階 2 実装計画：PD 原稿の IR を OpenRouter で作り、共通の 1 枠の使用率を測る

根拠は origin/master 21c25c73 の git object の読取りだけです。実行はしていません。「確認済み」は file:line を読んだもの、「推測」は読みからの推論です。

## 1. 結論

**できます。ただし現状の道具のままでは回せず、新しい launcher が要ります。** 段階 1 の道具 `scripts/quality/fusion-slot-eval/` は、branch `claude/fusion-slot-pd-eval`（tip 21c25c73 は origin/master と同じ）にまだありません。以下は L0 の `scripts/quality/setup-nir1-retrieval.mjs` と `run-nir1-retrieval.mjs` を基準にしています。

主な難所は 5 つです。

1. **偽 AI の固定（確認済み）。** `electron/scripts/product-journey-harness.mjs:5240` は launch のたびに `GRIMODEX_PRODUCT_JOURNEY_FAKE_AI=deterministic-v1` を立てます。L0 の setup を流用すると固定 JSON が返り、OpenRouter には届きません。env を立てない launcher（`run-nir1-retrieval.mjs` 系、`_electron.launch`）を土台にします。
2. **key の保管（確認済み＋推測）。** key を入れる製品経路は `save_api_key`（safeStorage）だけで、env から読む seam は main にありません（`keyStore.ts:216-231,334-392`）。Linux で backend が basic_text／unknown だと save も get も throw します（`keyStore.ts:185-201`）。isolated な private D-Bus には secret service が無い見込みです（推測）。
3. **reasoning medium は指定できません（確認済み）。**
   - narrative 経路は `thinkingParams=undefined` で呼びます（`runObservationExtractionTask.ts:555-567`）。
   - Rust は `reasoning_enabled` が Some のときだけ reasoning を付けます（`lib.rs:3513-3527`）。
   - `reasoning_effort_override` は Rust が読みません。
   - 結果は OpenRouter／モデルの既定になります。固定するなら製品コードの変更になり、委任の範囲外になり得ます。結果には「reasoning は既定のまま」と注記します。
4. **IR の admitted 全件は fetch の結果から読めません（確認済み）。** `begin` の応答に `ir.scenes` は無く、全件は `related_scenes_continue` の応答にだけあります（`relatedScenesSearchWire.ts:150-174`）。Raw が 8 件で枠が閉じていると、fuse が IR-only の候補を捨てます。そこで別 operation の probe を足します（5 節）。
5. **承認は UI の 1 件ずつの操作が必要です（確認済み）。** secret のままの root は IR に出ません（`disclosure.rs:164` の `Reason::Secret`）。一括承認は root を承認するので IR に入りません（`chronicleExtractionApi.ts:1913-1940`）。「secret を外した child を作る」→「その child を承認」の順で、1 提案ずつ行います。

## 2. 手順

### 2.1 作る file

すべて新規の `scripts/quality/fusion-slot-eval/` 配下です。凍結物には触りません（5.4 節）。

| file | 役割 |
|---|---|
| `launch.mjs` | `run-nir1-retrieval.mjs:395-440` を複製した launcher。FAKE_AI の env を立てず、立っていないことを assert する。 |
| `eval-main-key-seam`（main への最小差分。2.3 節） | key をファイルから env で受ける eval 専用 seam。 |
| `extract.mjs` | 原稿 → Scene 作成 → 抽出 → child 作成 → 承認の driver。 |
| `renderer.html`／`renderer.ts` | `evals/nir1-retrieval/renderer.html` 方式。`startChronicleExtraction`／`reviseChronicleProposal`／`decideChronicleProposal` と `measureHybrid`／`finalizeHybrid`／`buildIr`（複製）を `window` から呼べるようにする。 |
| `probe.mjs` | 5 節の別 operation probe。 |
| `measure.mjs` | 25/50/75/100% × 末尾 10 Scene の測定ループと集計。 |

`electron-observer.mjs` は再利用します（確認済み。「結果を保持しない」方針）。`paired.mjs` は複製のみで、digest や gold には束縛されません（`paired.mjs:32-55,83-153`）。IPC 回数の健全性検査（begin／fts_search／db_execute が各 1 回、semantic_search が 0 回）は流用できます（`paired.mjs:171-195`）。

### 2.2 使う既存の関数・IPC

- **profile の準備（`run-nir1-retrieval.mjs:377` ほか）。**
  - `legacy-keyring-migration-v1.json` を先に置きます。OS keyring の旧 key が eval profile に取り込まれるのを防ぐためで、必須です（`main/index.ts:312-335`、`credentialMigration.ts:27`）。
  - `global-settings.json`（autoBackup=false）を置き、d2a-mode は unrestricted にします。
  - model の配置と sha256 sidecar も L0 に倣います。
- **AI 設定。** `save_ai_settings` で provider=`openrouter`、model=`openai/gpt-5.6-luna`。role 別の上書きは設定しません（`resolveRoleSendOverride` が既定に落ちる）。
- **抽出。** `startChronicleExtraction`（`chronicleExtractionApi.ts:659-678`）を renderer.html から直接呼びます（推測）。
  - 呼ぶには workspace identity と AI 設定ストアの初期化が renderer 側で要ります（`singleShotTransport.ts:28`）。
  - 失敗時は `narrativeExtractionFailTask`（requeue:false）で止まり、未解決の resume 候補が新規「解析」を拒否します。そのため失敗後は discover → discard（または resume）を driver に実装します。
- **child 作成。** `reviseChronicleProposal({secret:false})`（`chronicleExtractionApi.ts:1828-1912`）。human-derived の scope-override child ができます。
- **承認。** child の revision に `decideChronicleProposal({status:'approved'})`（同 `:1631-1676`）。actor は Rust が `electron:human-review` に固定します（`repository.rs:5558-5570`）。
- **順序は revise が先、承認が後です。** 逆だと decision が古い revision を指して失効します（確認済み）。
- **「取り込み」（`applyChronicleExtractionCommit`）は不要です。** IR の admission に要らず、L0 も取り込んでいません。
- **Scene の構成。** Scene ごとに別 folder を作って 1 つずつ解析します（L0 の流儀）。
  - IR は scene exact で、query の scene より読み順が前のものだけが出ます（`disclosure.rs:197-250`）。
  - 提案の scene ref は「最初の anchor の document」1 つで決まるため、複数 Scene をまとめて解析すると帰属が曖昧になります（推測）。
  - folder なしで `sceneIds=[1件]` を渡せるかは未確認です。パイロットで確かめます。

### 2.3 key の渡し方（ファイル → env → main のメモリのみ、profile に残さない）

**推奨は eval 専用 seam（案 B）です。**

1. launcher（node）が `~/.config/grimodex-eval/openrouter.key` を読みます。形式検証は先行の `.artifacts/narrative-eval/chronicle-full-calibration-20260907/helper/key-reader.mjs`（`sk-` 形式）に倣い、値は表示も記録もしません。
2. `_electron.launch` の env に `GRIMODEX_EVAL_OPENROUTER_KEY` を載せます。他の env は L0 と同じです。
3. main 側に、`!app.isPackaged` かつ env 一致のときだけ有効な SecretsBridge の差替えを足します。形は `productJourneyAi.ts:92-120` の wrapper と同じです（確認済みの前例）。
   - provider が openrouter のときだけ env の key を返します。
   - 読んだら `process.env` から消します。
   - safeStorage と `ai-keys.json` には一切触りません。profile に暗号文も残りません。
4. これは製品コード側に足す差分で、新しい資格情報経路です。**GDX-PRECHECK-001 の対象になり得る**ので、実装前に decisions 文書と PR 本文に判断と信頼境界を残します。

ユーザーが承認済みなのは「OpenRouter での抽出」と「key をファイルで渡すこと」です。seam の追加が委任に含まれるかは未確認です。含まれないと判断した場合は `[precheck]` で止まります。

**代替案（推奨の順）**

- **案 C。** 事前に Electron で `safeStorage.getSelectedStorageBackend()` を一度だけ確かめ、desktop session（gnome-keyring／kwallet がある）で `save_api_key` します。
  - 製品経路そのままで、測定の妥当性は一番高くなります。
  - ただし暗号化された `ai-keys.json` が profile に残るので、終了時に profile を削除します。
  - 削除前に `--ignored` で中身を確かめます（`.ralph/` や `.artifacts/` が worktree remove で消えた過去の失敗）。
  - isolation 方針（Wayland／D-Bus 変数の除去）との折り合いも記録します。
- **案 A。** openai-compatible の localhost 転送 shim。openai-compatible は key が任意で safeStorage に触れません。
  - ただし provider が `openai-compatible` になり、wire が変わります（max_tokens 4096 など。`lib.rs:1075-1118`）。
  - 「製品の OpenRouter 経路」ではなくなるため、非推奨です。
- **案 D。** coordinator の `deps.observeWithAi`／`synthesizeWithAi` を差し替えて renderer から直接叩く方法は採りません。key と HTTP が renderer 側に出ます。

**注意（推測）。** env は同一ユーザーが `/proc/<pid>/environ` から読めます。main が読んだら消し、profile や log には残しません。

### 2.4 承認の代行

L0 は UI を Playwright で操作しますが、本計画は renderer.html の直接 API 呼出しを使います（2.2 節）。

1. `startChronicleExtraction` の完了を待ちます。待ちの上限は L0 の 60 s では足りないので Scene 単位で 10 分程度に伸ばし、DB／IPC を poll します。
2. 提案を列挙します。件数は 0 件も複数件もあり得ます。L0 の「丁度 1 件」の assert（`assertInitialProposals(...,1)`）と `interpretationSeed` との照合は外します。
3. **全提案**に対して、`reviseChronicleProposal({secret:false})` で child を作り、child の revision を承認します。
4. 提案ごとに、approved 数と、その提案の scene、evidence 数を記録します（本文は記録しません）。

**測定の妥当性について（推測）。** 全提案を非 secret にするのは IR が最大限使われる条件で、製品の既定（secret のまま承認すると IR は出ない）とは違います。結果には「IR 最大条件の下での枠の使用率」と明記します。

### 2.5 25/50/75/100% の作り方

reading order の接頭辞を段階的に足しながら抽出し、各段階で DB を複製する方式が最安です（推測）。成立するかは**パイロットで先に確かめます**。

- 根拠は、非 secret の child の scope 制御が `scope-dependency-projection` で、projection_revision は anchor／reveal の source key にだけ依存し、全 Scene の roster に依存しないらしいことです（`narrative_scope_dependency_projection.rs`）。
- 一方、root の project-scope-authority token は全 Scene の mapping の digest なので、Scene を足すと root は失効します（`narrative_project_scope_authority.rs:308-370`）。
- 確かめる内容は「承認後に Scene を足しても IR の doc 数が減らないか」です。偽なら checkpoint ごとに別 project として抽出し直しになり、抽出量は約 2.5 倍になります（0.25+0.5+0.75+1.0）。

複製した DB ごとに次を行います。

1. `open_workspace`
2. Raw の cold build（`semanticReindexAll`）
3. IR の build 待ち。L0 の `buildIr` の上限 30 s は PD の規模では足りない可能性が高いので、伸ばします（`begin.rs:294-296`、`build.rs:8-62`）。完了は `related-scenes:index-ready` です。

## 3. 測る値の定義

判定は reason の文字列ではなく `completion.outcome` で行います（renderer が expired→invalidated、capacity→failed に潰すため）。

分類は次の順です。`measureHybrid` が返す `initialSnapshot`／`completion`／`result` で足ります。

1. `querySupported===false`：対象外。
2. `indexUsable===false`：IR 未構築。分母から除き、件数は別に報告します。
3. `outcome==='timeout'`（result は `kind:'raw'`、`ir.reason:'timeout'`）：**IR が間に合わなかった**。
4. `ir-unavailable`／`failed`／`cancelled`／`invalidated`：故障。capacity と failed は区別できません。
5. `ir-ready` かつ `kind==='raw'`、`ir.status==='empty'`：admitted が 0 件。
6. `ir-ready` かつ fused：
   - Raw が 8 件で枠が閉じていた場合は「**Raw 満杯**」。
   - Raw が 8 件未満で、ir 行が無い場合は「admitted が全て Raw と重なった」。
   - ir 行がある場合は「**枠を使った**」。

指標は 4 つです。

| 指標 | 定義 |
|---|---|
| **IR が枠を使った割合（主指標）** | `kind==='ir'` の行がある ÷（`indexUsable && querySupported` かつ `ir-ready` かつ Raw が 8 件未満）。raw-ir は含めません。`paired.mjs:395-416` の `withIr` は `kind!=='raw'` で raw-ir を含むため流用しません。 |
| **IR が unavailable の割合** | 分類 3 と 4 の合計 ÷ 全サンプル。timeout は別行で報告します。 |
| **Raw 満杯で IR 候補あり** | Raw が 8 件、かつ probe の admitted に Raw 外の scene が 1 件以上ある割合。 |
| **反実仮想** | timeout だったサンプルのうち、probe の列に Raw 外の scene があり、Raw が 8 件未満で、使えたはずだった割合。 |

- 測定中は Graph を呼びません（`graphSeedEntityId` を渡さない）。
- **probe（別 operation）。** 各サンプルを `finalizeHybrid` で解放した後、同じ query で `beginRelatedScenes`→`continueRelatedScenes`→`releaseRelatedScenes` を呼びます（`nir1RelatedScenesApi.ts` は export 済み）。
  - 測定の timing を汚しません。
  - continue は deadline なしに待ち、floor（ja=0.813、en=0.66）、scene 最大、上限 8 件を通した後の列を返します（`scoring.rs:78-109`）。
  - 返る列は floor 通過後なので、floor 前の候補は見えません。この限界を結果に書きます。
- `finalizeHybrid` の呼び忘れは次の `measureHybrid` の precheck 失敗と registry の capacity 消費を招くので、必ず `finally` で呼びます。
- 末尾 10 Scene を `activeSceneId` に順に設定して数回ずつ反復し、timeout の揺らぎは分布で見ます（D=10.84 ms は Raw-ready 基準。`relatedScenesConfig.ts:7`）。

## 4. 費用と時間の見積もり（すべて推測）

前提は、1 Scene（≤6000 字）あたり observation 1 回＋synthesis（観測数）回＋repair 最大 +1 で概ね 6〜12 回、1 呼出し 15〜60 s です。cluster 数は観測数にほぼ比例すると仮定しています。コード上に件数・回数の上限は見当たりませんでした。

| 項目 | 見積もり |
|---|---|
| 抽出（約 100 Scene） | LLM 待ちが 0.5〜2.5 時間。 |
| 承認（提案数百件） | 15〜50 分。直接 API 呼出しなら UI クリックより短い見込み。 |
| ビルドと測定 | checkpoint あたり数分、測定全体で数十分以内。 |
| 費用 | 単価は calibration helper の入力 $0.25／百万、出力 $1.5／百万（`manifest.json`）。1 呼出し約 $0.01、200 回前後で約 $2、再試行込みでも $10 未満。 |

reasoning を指定できないので、モデル既定の reasoning token が出力に積まれて上振れする可能性があります。

**費用の上限は閾値方式で止めます。**
- folder ごとに `ai_usage`（`recordAiUsage`）か OpenRouter の `usage.cost` を確認します。
- 累計が閾値（口座残高の範囲内でユーザーと決める）を超えたら中断します。
- この閾値方式は未検証です。パイロットで記録が取れるか確かめます。

## 5. 危険

### 5.1 key の漏れ
- key は launcher の env → main のメモリにだけ置き、読んだら env から消します。
- 診断出力、Playwright の trace、`ps` 風の表示、エラー文で env 全体を出力しません（launcher の env 構築部と例外処理で値を伏せる）。
- profile の `ai-keys.json` と暗号文の有無を、終了時に `find` で検査します。
- egress は OpenRouter のホストだけに制限します。先行の `openrouter-fetch-guard.mjs` が前例です。
- 送信範囲は PD 本文のみです。
- external-egress と資格情報の seam は GDX-PRECHECK-001 の対象になり得ます。実装前に decisions 文書と PR 本文へ判断と信頼境界を残します。

### 5.2 本文のログへの混入
- observer は結果を保持しません（L0 の方針）。
- extract／measure の log には ID、件数、duration、outcome の enum だけを出します。
- 提案の内容、evidence の抜粋、AI の応答、`measureHybrid` の scene の本文は出しません。
- log と成果物を最後に走査します（PD 本文の断片と key 形式の grep）。

### 5.3 IR の待ちの上限での取りこぼし
- D=10.84 ms は Raw-ready 基準で、IR が届いても D を過ぎると `timeout` に差し替わります（`awaitNir1RelatedScenes.ts:38-84`）。
- 100% 地点で doc 数が増えると timeout が増える方向に働きます（推測）。
- timeout と「枠を使わない」は別行で報告し、probe の反実仮想で補います。
- 反復して分布で見ます。

### 5.4 凍結物への接触
次は読むだけで、変更しません。

- L0 の contract、`prepared-setups`、`paired.mjs`
- `policies/narrative/nir1-related-scenes-ranking.json`
- 閾値（floor、D、maxScenes、maxAdditionalScenes）

閾値の緩和と黙示変更は委任外です。main の key seam は eval 専用の最小差分にとどめ、製品の既定動作と契約（`ipcContract.ts`）は変えません。

### 5.5 そのほか
- **失敗の連鎖。** 1 件の失敗で後続の「解析」が全部拒否されます。driver に discard／resume を実装します。
- **偽 AI の混入。** launcher で FAKE_AI の env が無いことを assert します。抽出の応答に固定 JSON（'Product Journey'）が現れたら中断します。
- **IR の pool が承認数より小さくなりえます。** scope exact／any、Freshness、source が query より前、identity 一致などの条件があります（`disclosure.rs`、`retrieval_admission.rs:36-166`）。approved 数と IR の doc 数（または probe の列）を並べて報告します。
- **日本語の sparse query は Codex の言及に依存します**（`fetchNir1RelatedScenesSparseQuery`）。eval profile に Codex が無いと Raw が本番より細く、枠が開きやすく出ます。結果の解釈に書きます。
- **言語の整合。** PD 小説が英語なら `project.language`、`startChronicleExtraction` の language（既定 `'ja'`）、prompt（日本語）の整合が要ります。floor も言語で変わります。
- **非 secret の child にした場合の測定の偏り。** 提案は actual／attempted／prevented かつ major／scene-level に限られ、0 件の Scene が出ます。最初の方の Scene の query には IR が出ません（`SourceNotBeforeQuery`）。母数と定義に反映します。
- **資源。** 実 LLM の抽出は長時間かかります。既存 harness の上限（操作 30 s、lane 15 分）は使わず、独自の timeout と folder 単位の checkpoint（DB 複製）を持ちます。

## 6. 確かめられなかったこと

- 段階 1 の道具の実際の構成（branch に未作成）。実装前に branch の最新を確認します。
- 環境側の safeStorage backend（secret service の有無）。事前の Electron probe が要ります。
- folder なしで `sceneIds=[1件]` を渡せるか。renderer.html 方式での `startChronicleExtraction` の authority／workspace identity／AI 設定ストアの初期化。
- 非 secret の child が Scene 追加後も失効せず、IR の doc 数が減らないこと（2.5 節のパイロット）。
- 実モデルの出力が admission の条件（scope exact、Freshness など）を全て通る割合。
- synthesis の `NEX_CHRONICLE_SYNTHESIS_TERMINAL_OUTPUT_REQUIRED` がどの経路で失敗になるか。
- license ガード（`blockNarrativeAiTask`）が eval profile で AI をブロックしないこと。L0 setup が通る事実から、ブロックしない見込みです。
- 費用の閾値方式（`ai_usage` の記録で止められるか）、および §4 の時間・費用の見積もり全体（推測）。
- main の key seam の追加が、ユーザーの事前委任（OpenRouter での抽出と key のファイル渡し）に含まれるか。含まれないなら `[precheck]` で停止して確認します。案 C を選べば seam は不要です。