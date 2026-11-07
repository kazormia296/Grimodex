# 事前登録（下書き）：PD の原稿で IR が共通の 1 枠を使う割合（融合の枠の評価・段階 2）

- 状態：**下書き**（2026-11-03）。確定するまで、runner（`ir-slot.mjs`）は本番の作品（role `main`）を拒む（段階 1 と同じ `assertRunnable`：1 行目に「下書き」がある間、または sha256 が合わない間は走らない）。
- 作成：2026-11-03。branch `claude/fusion-slot-ir-eval`（段階 1 の branch `claude/fusion-slot-pd-eval` の `0fb1487e` から切った）。
- evidenceScope：**`not-cp4-evidence`**（CP-4 の証跡にも判定にもしない）。
- ユーザーの決定：contracts の `user-confirmation-2026-11-03-pd-raw-cloud-ir.md`（クラウド LLM で抽出、費用は口座の残高まで、key は file → デスクトップの keyring）。実装計画：`ir-cloud-extraction-plan-2026-11-03.md`。

## 0. 確定の前提条件（未達）

1. **製品の不具合 1（解消済み）。** OpenRouter が `message.reasoning` を返すと、thinking の `summary: null` を renderer が拒んで抽出が止まった。PR #786（branch `claude/fix-thinking-summary-null`、`febd60a3`）で Rust の `ResponseBlock::Thinking` に `skip_serializing_if` が付き、この branch に merge した（`d1a2d618`）。再試行では 15 回の呼出しが全部 transport として成功した。
2. **製品の不具合 2（PR #788、`88e6f795` で解消。この branch に merge 済み `fe0c374a`）。** 合成（event synthesis）の段が `NEX_CHRONICLE_SYNTHESIS_TERMINAL_OUTPUT_REQUIRED` で失敗する（`runs-ir/trial2-scene-1`、Scene 1）。
   - 観測の段は `actuality` に `hypothetical` などを許す（`src/application/narrative-extraction/aiTasks/observationPromptGuidance.ts:13`）。
   - 合成の prompt（`runEventSynthesisTask.ts` の `EVENT_COMPONENT_CONTRACT`、109〜119 行）は、許す値を列挙せずに例として `"actual"` だけを示し、各観測の `actuality=hypothetical` を model に見せる。
   - 合成の schema（`src/features/chronicle/extraction/schemas.ts:36-41`）が許すのは `actual`／`attempted`／`prevented`／`rumored` だけ。
   - 実測：合成 10 cluster のうち 6 件が parsed、4 件が invalid。invalid の 4 件は、いずれも JSON として読め、key は揃い、clusterRef も正しく、`actuality` だけが `"hypothetical"` だった。修復（structured repair）の 4 回は同じ形を返して全部 invalid。
   - coordinator は、1 つの cluster でも終端の出力が無いと run 全体を失敗にする（`extractionCoordinator.ts:1649`）。
   - したがって、仮定の観測を含む Scene は抽出できない見込み（推測。Scene 1 以外では確かめていない）。集計は `runs-ir/trial2-scene-1/synthesis-diagnosis.json`（件数と enum だけ）。
2b. **IR の query が対象外になる（ユーザーが案 B を選択。測定では B の既定を再現する。§3）。** 抽出なしの run（`runs-ir/skip-all-2`）で全 96 sample が `querySupported=false`（Native の `unsupported-query`）。新しい Scene は作成時に scope の binding が `compatibility_marker: unknown`（軸は `unresolved`）で入り（`scene_scope.rs:464`）、IR の query の文脈はそれを `ScopeUnsupported` にする（`retrieval_admission/query_context.rs` の 120〜133 行）。作者が scope を明示（製品の `narrative_scene_scope_update`、UI は `SceneScopeEditor`）しない限り、新しい Scene では IR が出ない見込み。harness が scope を代行して設定するか（どの値か）は未決。
3. 2 と 2b の修正・決定の後の head で標準 build を取り直し、`t-ja-1` の試運転を最後まで通す（抽出・承認・IR の build・測定・地点の作り方の判定）。
4. 試運転の結果で §4 の地点の作り方を決め、§8 に費用と時間の実測を書き、この file の題と状態の行を「確定」に替えて sha256 を contracts に記録する。

## 1. 目的

関連場面の一覧（最大 8 件）で、Raw に無い Scene を足せる共通の最大 1 件の枠を IR がどれだけ使うか、また Raw が 8 件満杯で枠が閉じていたときに IR の候補があったかを、PD の小説で測る。枠の見直しの材料にする（段階 1 の Raw の満杯率と合わせて読む）。

## 2. 作品

段階 1 の確定した事前登録（`preregistration.md`、§2）と同じ 6 作品と試運転の 1 作品。Scene の JSON も同じ（`scenes/<key>.json`、sha256 は manifest.json の `prepared`）。本番の 6 作品は合計 483 Scene（110＋117＋34＋71＋82＋69）。

## 3. 抽出と承認（IR の作り方）

- **scope（案 B の既定の再現）**：ユーザーは「新しい場面は project の既定の scope（最初は本筋）を受け継ぐ」案 B を選んだ（製品は未実装）。測定ではその既定の状態を再現する。各地点で Scene を入れた後・抽出の前に、作者の UI と同じ IPC で、registry に `timeline:main`／`worldline:prime`／`layer:manuscript` を入れ（初回だけ）、足した Scene の scope を `narrative_scene_scope_update` で explicit（query と material は同じ本筋の exact、holder と audience は reader）にする。DB の binding が全部 explicit であることを確かめ、そうでなければ止める。回想・夢・別の世界線などの区別はしない（全 Scene を本筋とする）。
- 抽出：製品の Chronicle 抽出（`startChronicleExtraction`、useAi=true）を Scene ごとに 1 回。Scene は 1 件ずつ folder に入れ（folder が読書順、Scene は folder 内の `a0`）、`folderId` と `sceneIds=[その Scene]` で呼ぶ（L0 の流儀）。言語は作品の言語。既存の事象のカタログは project の現在の事象（取り込みはしないので空）。
- AI：OpenRouter、model `openai/gpt-5.6-luna`。**reasoning は製品の抽出の経路から指定できないので、OpenRouter／model の既定のまま。** role 別の上書きは設定しない。
- key：デスクトップの keyring。製品の `save_api_key`（Electron safeStorage）で評価用の profile にだけ入れる。key は `~/.config/grimodex-eval/openrouter.key`（権限 600）から node が読み、形式は接頭辞と長さだけを確かめ、値は表示・記録しない。旧 keyring の取り込みを防ぐ印（`legacy-keyring-migration-v1.json`）を先に置く。keyring の項目は、秘密以外の property（Attributes／Label／Created／Modified／Locked）の digest を、起動の前・key の保存の後・終了の後で比べ、既存の項目が変わったら抽出に進まない。評価用の profile は終了後に中身（相対 path と大きさ）を記録してから消す。
- 承認：harness が代行する。**全提案**を `reviseChronicleProposal({secret:false})` で非 secret の child にし、その child を `decideChronicleProposal({status:"approved"})` で承認する（revise が先、承認が後）。取り込み（apply）はしない。したがって結果は「**IR が最大に出る条件の下での枠の使用率**」で、製品の既定（secret のまま承認すると IR に出ない）や作者が承認する率ではない。
- 失敗・0 件・複数件の提案はそのまま記録する（失敗した Scene は除かず件数を報告する）。抽出の失敗の後は、次の解析を拒む resume 候補を捨てる。

## 4. 地点と query の選び方

- 地点：段階 1 と同じ 25％・50％・75％・100％、Scene 数は `ceil(f × N)`（2 以上）。query は各地点の末尾から最大 10 件（位置 2 以上）。
- **地点の作り方（未判定）**：第一案は、1 つの project に読書順で Scene を足し、地点ごとに足した Scene を抽出・承認してから測る（抽出は 1 作品 1 回分）。成立の条件は「承認の後に Scene を足しても、前の地点で probe が admitted にした Scene が全て残ること」で、runner が地点ごとに確かめて記録する（`checkpointConstruction`）。試運転でこれが崩れたら、地点ごとに別 project で抽出し直す（抽出量は約 2.5 倍）。
- 段階 1 との違い：段階 1 は地点ごとに別の workspace で Scene を root の直下に入れた。段階 2 は folder の下に入れ、Raw も同じ project の hybrid の fetch の中で測る。Raw の件数は段階 1 と完全には一致しない可能性がある。
- 各 query で、製品の `fetchRelatedPastScenes(sceneId, {mode:"hybrid"})` を 3 回呼ぶ（timeout の揺らぎを分布で見る）。session は毎回解放する。Graph は呼ばない（`graphSeedEntityId` を渡さない）。
- IR の build：地点ごとに Raw の index を作り直し（`semanticReindexAll`）、実際の query の経路で IR が使える（`indexUsable`）まで最大 5 分待つ。`related-scenes:index-ready` の回数も記録する。

## 5. 指標

分類は計画 §3 の順に `completion.outcome` で判定する（`ir-classify.mjs`）。

| 分類 | 定義 |
|---|---|
| 対象外 | `querySupported=false` |
| IR 未構築 | `indexUsable=false`（分母から除き、件数は別に報告） |
| IR が間に合わない | `outcome=timeout` |
| 故障 | `ir-unavailable`／`failed`／`cancelled`／`invalidated`、または fetch の失敗 |
| IR ready で枠を使った | `kind:"ir"` の行がある |
| IR ready で枠を使わなかった | 細目：IR の admitted が 0 件／Raw が 8 件で枠が閉じていた／Raw が 8 件未満で admitted が全て Raw と重なった |

- **主指標（枠の使用率）**：`kind:"ir"` の行がある ÷（IR ready かつ Raw が 8 件未満）。`raw-ir` は含めない。
- IR が使えなかった割合：（間に合わない＋故障）÷ 全 sample。間に合わないは別の行でも出す。
- **Raw 満杯で IR 候補あり**：Raw が 8 件の sample のうち、probe の admitted に Raw の外の前の Scene が 1 件以上ある割合。
- 反実仮想：間に合わなかった sample のうち、Raw が 8 件未満で probe に Raw の外の候補があった割合。
- probe：hybrid の session を解放した後、同じ query（`buildSemanticRecallQuery`）で別 operation の begin→continue（deadline なし）→release。continue の列は floor（ja 0.813、en 0.66）・Scene ごとの最大・上限 8 件を通った後のもので、**floor 前の候補は見えない**。
- 全体・作品ごと・地点ごと・言語ごと。query は独立でない（同じ作品・隣の Scene・3 回の反復）ので、区間は記述的な目安。

## 6. 判断規則

段階 1 と同じく最小限（ユーザーの決定 `853c8e27`）。

- **D0（判断不能）**：IR ready かつ Raw が 8 件未満の sample が 200 未満なら、主指標から結論を出さない。
- **D1（入力が無い、上限 5％）**：IR 未構築・故障の合計が全 sample の 5％ を超えたら、入力（IR）が無い測定として扱い、主指標から結論を出さない。
- **κ の下限 0.6**：ラベルを付けないので当たらない。
- 枠の案の採否の閾値は置かない。採否はユーザーが結果を見て決める。

## 7. 記録と隔離

- 記録：件数、分類、不透明 ID（作品・抽出の run は run ごとの salt で sha256）、Scene の位置、提案の enum（actuality・significance・適用可否）と evidence の数、usage（token 数）。本文・題名・抜粋・LLM の応答の本文は書かない。抽出の失敗の形は、ASCII 以外を伏せ、長い英数字列を伏せた 240 字まで。全記録に `"evidenceScope": "not-cp4-evidence"`。
- 置き場所：repo の外 `/home/grimodex/fusion-eval-data/pd-2026-11/runs-ir/`。workspace の DB（PD の本文と、監査に残る LLM の応答を含む）も同じ dir の下に残る。
- 実行環境：標準 build（受領書 `/home/grimodex/fusion-eval-data/pd-2026-11/build-ir-5/standard-build-receipt.json`、head は §7 の harness の commit と同じ）。`node scripts/local-ci-xvfb.mjs node …` を host の namespace で。`WAYLAND_DISPLAY`／`XDG_SESSION_TYPE`／`WAYLAND_SOCKET`／proxy の変数と `GRIMODEX_PRODUCT_JOURNEY_FAKE_AI` を除き、**`DBUS_SESSION_BUS_ADDRESS` だけ残す**（keyring の経路）。`ELECTRON_OZONE_PLATFORM_HINT=x11`、`TMPDIR=/tmp/gr5`。偽の AI の env が立っていないことを node 側と main 側で assert する。起動の script は `run-ir-trial.sh`（試運転用）。
- 送信先：OpenRouter（PD の本文だけ。ユーザーのデータは送らない）。
- 道具（下書きの時点。§0 の後に書き直す）：`ir-slot.mjs` `403718de…`、`ir-renderer.ts` `03cf0750…`、`ir-renderer.html` `a010188c…`、`ir-classify.mjs` `a5599679…`（harness の commit `0e44bf23`）。

## 8. 費用と時間（試運転の実測と本番の見積もり）

**試運転の実測**（`runs-ir/trial3-all`、t-ja-1 の 18 Scene、全 4 地点、2026-11-03 15:51〜16:28 UTC、head `0e44bf23`）：

| 項目 | 値 |
|---|---|
| 抽出 | 18 Scene 中 17 完了・1 失敗（位置 15、`NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED`。原因は未特定） |
| 提案 | 236 件、全部承認（revise→承認の失敗 0）。抽出前は 236 件全部が secret。actuality は actual 232・attempted 4、significance は全部 major |
| 1 Scene の提案の件数 | 4〜22（4・7・8・9・11・13・14 が各 1、15 が 2、16 が 3、17 が 2、18 が 2、22 が 1。中央値 15） |
| OpenRouter の呼出し | 386 回（全部成功）。入力 420,144 token、出力 131,904 token |
| 費用 | 仮定の単価で約 $0.30（実費は dashboard で確かめる。`ai_usage.cost_usd` は 386 行すべて null） |
| 時間 | 抽出の合計 2,123 秒（1 Scene 平均 118 秒、最大 175 秒）、run 全体 2,207 秒（約 37 分） |

**本番の見積もり（推測。上の実測から Scene 数で外挿）**：t-ja-1 の Scene は平均 約 2,000 字で、本番の作品の平均と近い。1 Scene あたり呼出し 約 21 回、入力 約 23,000、出力 約 7,300 token、約 2 分。

- 本番 483 Scene：呼出し 約 1 万回、入力 約 1,100 万 token、出力 約 350 万 token。
- 費用（仮定の単価）：**約 $8**（幅を見て $5〜$15）。
- 時間：抽出は逐次で **約 16 時間**（幅を見て 12〜24 時間）。測定（地点ごとに数十秒〜数分）を加える。
- 地点の作り方は §4 の第一案（1 project に追加）で成立した（§9）ので、別 project は要らない。

## 9. 試運転（本番に使わない）

`t-ja-1`（18 Scene）だけで通した。結果は出力の形と経路の確認だけに使い、指標・規則は変えない。

- key の経路：safeStorage の backend は `gnome_libsecret`、keyring は前後で変化なし（13 件）。評価用の profile は中身を確かめて削除。
- scope：地点ごとに足した Scene が全部 explicit になった（5→9→14→18 件）。
- 版 3 の受領書が admission まで届いた：25％ 地点の位置 5 で、hybrid の結果に `raw-ir` の行があり、probe も admitted を返した。
- **地点の作り方（§2.5）**：前の地点の probe の admitted は、Scene を足して承認した後も全部残った（p25→p50 は 4 query、p50→p75 は 8 query、p75→p100 は 10 query を比べて、減った query は 0）。**第一案（1 project に追加）で成立**。
- 分類（96 sample）：IR が間に合わない（timeout）86、IR ready で枠を使わなかった 10（admitted 0 件 8・Raw と重なり 2）、枠を使った 0、対象外・IR 未構築・故障 0。主指標は 0/10。
- timeout：50％ 以降は全 sample が timeout。hybrid の fetch は約 100 ms で、締切（Raw の後に 10.84 ms）を過ぎた。段階 1 の本番の測定とは時間が重なっていない。
- Raw 満杯（18 sample）で Raw の外の IR 候補があったのは 6（75％ 地点 3/6、100％ 地点 3/12）。timeout の反実仮想は 3/86。
- IR の admitted は少ない：承認 236 件に対し、100％ 地点の probe の admitted は query あたり 0〜4 Scene（floor 通過後）。
- 抽出の失敗 1 件（位置 15）：error の形は「extraction mutation was bound to authority workspace … generation …6 instance 1, active authority is … generation …7 instance 2」。抽出の途中で workspace の authority の世代が進んだ。resume 候補の破棄は `NEX_CHRONICLE_RESUME_DISCARD_NOT_ALLOWED` で拒まれたが、次の Scene の抽出は通った。原因は未特定。本番でも同じ率（1/18）で起きると、Scene の約 5％ が抽出されない。

## 10. この結果で言えないこと

- 結果は「IR が最大に出る条件（全提案を非 secret で承認）」の値で、作者が承認する率や製品の既定の値ではない。
- 6 作品の性質（古典の文体、章・節の粒度、分割規則）と、この model・reasoning の既定・この prompt の範囲の値。
- Codex が無いので、日本語の sparse query は製品より細く、Raw が少なく出て枠が開きやすく出る可能性がある。
- probe は floor 通過後の列だけを見るので、「Raw 満杯で IR 候補あり」は下限寄りの値。
- Graph は測らない（標準 build で閉じている）。
