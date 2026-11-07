# 事前登録（確定・第 5 版）：PD の原稿で IR が共通の 1 枠を使う割合（融合の枠の評価・段階 2）

- 状態：**確定・第 5 版**（2026-11-05）。取り直す作品の範囲は、ユーザーが案 1（m-ja-2・m-en-1）を選んだ（2026-11-05「案1で」。案 2＝3 作品とも、は選ばれなかった）。
- 第 4 版の本測定（m-ja-2・m-en-1、build-ir-15、2026-11-04 15:32Z〜18:11Z）は、どちらも途中で止まった（m-ja-2 は位置 89、m-en-1 は位置 37 から `workspace lifecycle has active owners or unacknowledged work`。Freshness の liveness の不具合で、#801 で修正）。止まる前の地点でも、m-ja-2 は IR の窓 D=10.84 ms に間に合わない sample が大半だった（75％ 地点で 87 中 72）。**第 4 版の値は使わない**。
- 第 3 版の状態の記録（m-ja-1）：第 3 版（sha256 `96a6271c…`、contracts `f45bf975`、claude-sonnet-5-5）の本測定は m-ja-1 だけを走らせ、25％・50％・75％ の 3 地点（82 query）まで測った。100％ 地点の抽出の途中（位置 88）で、integrator が run の最中に評価の worktree へ PR を merge し、vite の再読込で run が止まった（作業の誤り。取り直さない＝ユーザーの決定）。
- 作成：2026-11-03（下書き `preregistration-ir-draft.md`）、確定 2026-11-04。branch `claude/fusion-slot-ir-eval`。
- evidenceScope：**`not-cp4-evidence`**（CP-4 の証跡にも判定にもしない）。
- ユーザーの決定：contracts の `user-confirmation-2026-11-03-pd-raw-cloud-ir.md`（クラウド LLM で抽出、費用は口座の残高まで、key は file → デスクトップの keyring）。実装計画：`ir-cloud-extraction-plan-2026-11-03.md`。

## 0. 確定の前提条件（達成）

1. 製品の不具合 1（thinking の summary null）：#786 で修正・merge。
2. 製品の不具合 2（合成の actuality）：#788 で修正・merge。
3. 新しい Scene の scope が unknown で IR が対象外になる件：ユーザーが案 B を選び、製品に入った（#791・#793）。測定は製品の既定をそのまま使う（§3）。
4. IR が締切に間に合わない件（試運転 3 で 86/96）：#792（qualify の proof の引き継ぎ）で 0/96（試運転 4・5）。
5. 製品の不具合 3（OpenRouter の gpt-6 系の出力の上限が 4,096）：#794 で修正・merge。
6. 試運転 5 が最後まで通った（§9）。§4 の地点の作り方は第一案で成立。
7. 保守の cutover が済む前に書き込みを始めると IR が作られない件（第 1 版の本測定の中断の原因）：harness が cutover を待ってから Scene を足す（§3）。製品側の直しは PR #797（この測定の build には含めない）。
8. AI を Anthropic に切り替えた（ユーザーの依頼「評価は Anthropic を優先」「key は keyring にある key で」、2026-11-04）。製品の不具合 4（Anthropic の 5 系がモデルの一覧・能力表に無い）と 5（thinking を切れない世代の既定の出力の上限が 4,096）を PR #796 で直し、この branch に取り込んだ。
9. 試運転 7（claude-opus-5-5）で位置 1〜14 の抽出が全部完了した（位置 15〜18 はアカウントの利用上限。ユーザーが上限を外した）。
10. model を claude-sonnet-5-5 に替えた（第 3 版）（ユーザーの依頼「200 ドルはヤバすぎ、sonnet にして下さい」、2026-11-04）。Sonnet 5.5 は thinking を切れない世代なので、出力の上限は #796 の 32,000。Sonnet での試運転は行わない（経路は試運転 7 と同じで、model の文字列だけが違う）。代わりに、本測定の 1 作品目の最初の 5 Scene の抽出の成否を integrator が見て、3 件以上失敗したら止めて原因を調べる（その場合は第 4 版で取り直す）。
11. **作品を 3 つに絞った**（ユーザーの依頼「6 作品は多すぎ、半分ぐらいに」、2026-11-04）：m-ja-1（第 3 版の値、3 地点）＋ **m-ja-2**（日本語で Scene が最も多い＝D0 の分母のため）＋ **m-en-1**（英語で原稿の総量が最も少ない＝費用のため）。選ぶ規則は Scene 数と総量だけで、測った値は使っていない（見ていた値は m-ja-1 の途中の分類だけ）。D0 の見込みは約 230 件（m-ja-3 を選ぶと約 175 件で不足）。
12. **m-ja-2・m-en-1 は製品の修正を入れた build で走らせる**（ユーザーの決定「ここまでの分は取り直さなくても良い。cache を直して測定を」「prompt を直してから走らせる」）：
    - PR #799（合成の prompt の clusterRef・significance の曖昧さの修正、修復の指示、受入れの述語。合成の契約の版 4）。
    - PR #798（抽出の 3 段の prompt cache。指示を system に移す送り方）。
    - 試運転 9（t-ja-1 の 25％、5 Scene）：抽出 5/5 完了、合成の拒否 0/61（修正前の試運転 8 は 13/54）、cache の読み取り 59,233 token。仮説の significance は scene-level 24・minor 29・major 2・incidental 1 で、提案は 26 件（scene-level 24・major 2）。**提案の作られ方が m-ja-1（修正前、提案は全部 major）と大きく違う**ので、作品ごとに分けて報告し、作品を足し合わせた主指標は参考にとどめる。

13. **IR の窓 D を 10.84 ms から 40 ms に広げた**（ユーザーの承認「変えていいです」、2026-11-05。PR #802、DR-IRW-1〜3、master `a7e96946`）。測定の済んだ workspace の写しで query だけを流す診断（harness の `--reuse-workspace`、評価の証拠にしない）で、Raw-ready から IR が届くまでは m-ja-2 で p50 18.3・p99 24.8・最大 25.5 ms（10.84 ms に入るのは 8.3％）、m-en-1 で p50 7.4・最大 12.3 ms（91.7％）だった。40 ms は両方の最大を覆う。Freshness の liveness の修正（#801、`a5c0e519`）も同じ build に入る。
14. **取り直す作品（案 1。ユーザーの決定「案1で」、2026-11-05）**：m-ja-2・m-en-1 を最初から取り直す（抽出から）。m-ja-1 は第 3 版の 3 地点の値を使う。m-ja-1 の 3 地点は IR の時間切れが 0 件で、IR は全部 10.84 ms 以内に届いていた。製品は IR が届いた時点で返すので、D を 40 ms にしても分類は変わらない。ただし #799・#798 の前（抽出の契約 v3、cache なし）の測定で、build も違う（§7、§10）。

## 1. 目的

関連場面の一覧（最大 8 件）で、Raw に無い Scene を足せる共通の最大 1 件の枠を IR がどれだけ使うか、また Raw が 8 件満杯で枠が閉じていたときに IR の候補があったかを、PD の小説で測る。枠の見直しの材料にする（段階 1 の Raw の満杯率と合わせて読む）。

## 2. 作品

段階 1 の確定した事前登録（`preregistration.md`、§2）と同じ 6 作品と試運転の 1 作品。Scene の JSON も同じ（`scenes/<key>.json`、sha256 は manifest.json の `prepared`）。本番の 6 作品は合計 483 Scene（110＋117＋34＋71＋82＋69）。

## 3. 抽出と承認（IR の作り方）

- **scope（案 B、製品の既定）**：製品に案 B が入った（SDEF PR-1 #791、PR-2 #793）。harness は project を作成画面の「本筋を既定にする」と同じ option（`createProject(…, {sceneScopeDefault:"main-line"})`、R12）で作り、Scene は製品の `tree_node_create`（human）で足すので、新しい Scene は本筋の既定を explicit の binding として受け継ぐ（R7・R8）。harness は registry も binding も書かない。各地点で Scene を入れた後・抽出の前に、足した Scene の binding が explicit で、query と material が本筋の exact（`timeline:main`／`worldline:prime`／`layer:manuscript`）、holder と audience が reader であることを読んで確かめ、DB の binding が全部 explicit であることも数える。1 件でも違えば止める。回想・夢・別の世界線などの区別はしない（全 Scene を本筋とする）。試運転 3 までは、製品の実装の前なので、同じ値を harness が IPC で書いていた（試運転 4・5 は製品の既定）。
- 抽出：製品の Chronicle 抽出（`startChronicleExtraction`、useAi=true）を Scene ごとに 1 回。Scene は 1 件ずつ folder に入れ（folder が読書順、Scene は folder 内の `a0`）、`folderId` と `sceneIds=[その Scene]` で呼ぶ（L0 の流儀）。言語は作品の言語。既存の事象のカタログは project の現在の事象（取り込みはしないので空）。
- AI：**Anthropic、model `claude-sonnet-5-5`**（ユーザーの依頼。第 1 版は OpenRouter の `openai/gpt-6-luna`、第 2 版は Anthropic の `claude-opus-5-5`）。reasoning・effort は製品の抽出の経路から指定できないので、製品の既定のまま（Sonnet 5.5 は thinking を切れない）。出力の上限は製品の既定（#796 の後、thinking を切れない世代は 32,000）。role 別の上書きは設定しない。
- key：ユーザーが製品（packaged の Grimodex）に保存した Anthropic の key（`~/.local/share/com.miyakey.grimodex/ai-keys.json`、safeStorage、keyring の「Chromium Safe Storage／Grimodex」）。harness が keyring の snapshot を取った後、自分の所有の 0700 の dir に 600 の FIFO を作り、復号の script（`product-key-to-fifo.mjs`、app 名 Grimodex、userData は使い捨ての一時 dir、製品の ai-keys.json は読むだけ）が 1 回だけ書く（`fifo-key.mjs`。O_CREAT なし・O_NOFOLLOW・fd で FIFO／所有者／権限を確かめる、読み書きとも期限つき）。harness は受け取った key を製品の `save_api_key` で評価用の profile にだけ入れる。key の値・長さは表示・記録しない。平文はディスクに残さない。旧 keyring の取り込みを防ぐ印を先に置く。keyring の項目は、秘密以外の property の digest を、key の受け取りの前・保存の後・終了の後で比べ、既存の項目が変わったら抽出に進まない。評価用の profile は終了後に中身（相対 path と大きさ）を記録してから消す。
- 承認：harness が代行する。**全提案**を `reviseChronicleProposal({secret:false})` で非 secret の child にし、その child を `decideChronicleProposal({status:"approved"})` で承認する（revise が先、承認が後）。取り込み（apply）はしない。したがって結果は「**IR が最大に出る条件の下での枠の使用率**」で、製品の既定（secret のまま承認すると IR に出ない）や作者が承認する率ではない。
- 失敗・0 件・複数件の提案はそのまま記録する（失敗した Scene は除かず件数を報告する）。抽出の失敗の後は、次の解析を拒む resume 候補を捨てる。
- **保守の cutover を待つ**：project を作った後、保守の C2-ZC cutover（`schema_data_migrations` の `narrative-c2-canonical-freshness-v1`）が済むまで最大 180 秒待ってから Scene を足す（harness は保守を起動しない）。済まなければその作品を止める。地点で IR が usable にならなければ、cutover の状態を記録してその作品を打ち切る（D1 の対象として報告する）。

## 4. 地点と query の選び方

- 地点：段階 1 と同じ 25％・50％・75％・100％、Scene 数は `ceil(f × N)`（2 以上）。**query は、その地点で足した Scene 全部（位置 2 以上）。各位置は足した地点で 1 回だけ引く**（related は前の Scene しか見ない）。段階 1 の「末尾から最大 10 件」から広げた理由：段階 1 の本番は query 238・Raw 満杯 190 で、Raw が 8 件未満は 48 query（×3 回で約 144 sample）。同じ選び方では D0 の 200 に届かない見込みなので、本測定の前に（データを見る前に）選び方を広げた。閾値は変えていない。見込みは 6 作品で約 477 query・約 1,431 sample。
- **地点の作り方（試運転で成立）**：第一案は、1 つの project に読書順で Scene を足し、地点ごとに足した Scene を抽出・承認してから測る（抽出は 1 作品 1 回分）。成立の条件は「承認の後に Scene を足しても、前の地点で probe が admitted にした Scene が全て残ること」で、runner が地点ごとに確かめて記録する（`checkpointConstruction`）。試運転 3・4・5 で、減った query は 0（§9）。本番でも記録し、崩れたらその作品の値に印を付けて報告する。比較は前の地点で引いた query の位置を引き直して行う。
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
- **層別（結果を見る前に決める）**：主指標と「Raw 満杯で IR 候補あり」を、前の Scene の数で層別して出す（<8／8〜30／>30）。query を広げたので、主指標の分母には「前の Scene が少なく IR に出すものがまだ少ない位置」が増える（値を下げる方向に働きうる。試運転 5 でも slot-unused 93 のうち IR が空 75）。
- **段階 1 と並べる部分集合**：引いた地点の末尾 10 件に入る query（`tail10`）だけの集計も別に出す。

## 6. 判断規則

段階 1 と同じく最小限（ユーザーの決定 `853c8e27`）。

- **D0（判断不能）**：IR ready かつ Raw が 8 件未満の sample が 200 未満なら、主指標から結論を出さない。
- **D1（入力が無い、上限 5％）**：IR 未構築・故障の合計が全 sample の 5％ を超えたら、入力（IR）が無い測定として扱い、主指標から結論を出さない。
- **κ の下限 0.6**：ラベルを付けないので当たらない。
- 枠の案の採否の閾値は置かない。採否はユーザーが結果を見て決める。

## 7. 記録と隔離

- 記録：件数、分類、不透明 ID（作品・抽出の run は run ごとの salt で sha256）、Scene の位置、提案の enum（actuality・significance・適用可否）と evidence の数、usage（token 数）。本文・題名・抜粋・LLM の応答の本文は書かない。抽出の失敗の形は、ASCII 以外を伏せ、長い英数字列を伏せた 240 字まで。全記録に `"evidenceScope": "not-cp4-evidence"`。
- 置き場所：repo の外 `/home/grimodex/fusion-eval-data/pd-2026-11/runs-ir/`。workspace の DB（PD の本文と、監査に残る LLM の応答を含む）も同じ dir の下に残る。
- 実行環境：m-ja-1 は第 3 版の build-ir-13（harness `44281c4d`、master `295158e2`）。**m-ja-2・m-en-1 は build-ir-23**（受領書 `/home/grimodex/fusion-eval-data/pd-2026-11/build-ir-23/standard-build-receipt.json`、head は harness の commit `cdcce37e`。master `a7e96946`（#798〜#802 を含む。D=40 ms）を merge したもの）。`GRIMODEX_WORKSPACE_OPEN_TRACE=1` を付け、main と renderer の出力のうち workspace／authority／recovery／restore／rollback の行を `workspace-trace.log` に残す（位置 15 の件の発生源を追うため。測定の値には使わない）。`node scripts/local-ci-xvfb.mjs node …` を host の namespace で。`WAYLAND_DISPLAY`／`XDG_SESSION_TYPE`／`WAYLAND_SOCKET`／proxy の変数と `GRIMODEX_PRODUCT_JOURNEY_FAKE_AI` を除き、**`DBUS_SESSION_BUS_ADDRESS` だけ残す**（keyring の経路）。`ELECTRON_OZONE_PLATFORM_HINT=x11`、`TMPDIR=/tmp/gr5`。偽の AI の env が立っていないことを node 側と main 側で assert する。起動の script は `run-ir-main-v5.sh`（本番。m-ja-2 と m-en-1 だけ。出力は `runs-ir/main5-*`。HEAD・clean・事前登録の sha256 を照合してから、作品ごとに別の process で走らせる）。
- 送信先：Anthropic の API（PD の本文だけ。ユーザーのデータは送らない）。
- 道具：§11 の sha256（harness の commit `cdcce37e`）。

## 8. 費用と時間

**試運転 7 の実測**（`runs-ir/trial7-anthropic`、t-ja-1、build-ir-12、claude-opus-5-5）：位置 1〜14 の抽出が全部完了（位置 15〜18 はアカウントの利用上限）。1 Scene の抽出は平均 約 150 秒・最大 257 秒。usage は入力 543,240、出力 206,985 token（約 15 Scene 分）。公表の単価（入力 $4／出力 $20 per 1M、cache の割引なし）で約 $6.3。

**本番の見積もり（推測。試運転 7 の opus の token 数から Scene 数で外挿、cache の割引なし）**：483 Scene で入力 約 1,750 万・出力 約 670 万 token。claude-sonnet-5-5 の公表の単価（入力 $2／出力 $10 per 1M）で約 $100（幅を見て $60〜$150。Sonnet の token 数は opus と違いうる）。抽出の時間は opus（約 20 時間）以下の見込み（推測）。query は約 477 件で、測定は作品あたり数分。

## 9. 試運転（本番に使わない）

`t-ja-1`（18 Scene）だけで通した。結果は出力の形と経路の確認だけに使い、指標・規則は変えない（query の選び方の変更（§4）は、試運転の値ではなく段階 1 の件数から決めた）。

- 試運転 3（gpt-5.6-luna、harness が scope を書いた）：抽出 17/18（位置 15 で `NEX_CHRONICLE_WORKSPACE_AUTHORITY_CHANGED`）、IR の timeout 86/96。
- 試運転 4（gpt-6-luna、製品の既定の scope）：IR の timeout 0/96。抽出 2/18（製品の不具合 3。§0 の 5）。
- 試運転 5（gpt-6-luna、#794 の後）：抽出 17/18、IR の timeout・未構築・故障 0/96。scope は全 Scene が本筋の explicit を受け継いだ（5→9→14→18）。keyring は 13 件・変化なし、評価用の profile は確かめて削除。前の地点の admitted は減らなかった（4・8・10 query）。分類：slot-used 3、slot-unused 93（IR が空 75、Raw 満杯 18）。
- 抽出なしの run（`runs-ir/skip-query-all`、build-ir-9）：§4 の新しい query の選び方が最後まで通ることを確かめた。
- 第 1 版の本測定（2026-11-04 06:56Z〜08:4xZ、m-ja-1）：25％ 地点（28 Scene）で IR が 5 分 usable にならず、81 sample 全部が ir-not-built。原因は保守の cutover が済まなかったこと。integrator が止めた（値は使わない）。
- 抽出なしの run（`runs-ir/skip-cutover`、build-ir-10）：cutover を 3 秒で待てて、IR が usable になることを確かめた。
- 試運転 6（claude-opus-5-5、build-ir-11）：抽出 4/18。失敗 14 件は全部出力 4,096 で切れた（製品の不具合 5）。
- 試運転 7（claude-opus-5-5、build-ir-12）：位置 1〜14 は全部完了、15〜18 はアカウントの利用上限。key は製品の profile から FIFO で受け取れ、keyring は 14 件のまま。cutover は 3 秒。IR の timeout・未構築・故障 0。分類は slot-used 6、slot-unused 45。

## 10. この結果で言えないこと

- 結果は「IR が最大に出る条件（全提案を非 secret で承認）」の値で、作者が承認する率や製品の既定の値ではない。
- 6 作品の性質（古典の文体、章・節の粒度、分割規則）と、この model・reasoning の既定・この prompt の範囲の値。
- Codex が無いので、日本語の sparse query は製品より細く、Raw が少なく出て枠が開きやすく出る可能性がある。
- probe は floor 通過後の列だけを見るので、「Raw 満杯で IR 候補あり」は下限寄りの値。
- Graph は測らない（標準 build で閉じている）。
- query を「足した Scene 全部」に広げたので、主指標は段階 1 の「末尾 10 件」と同じ母集団ではない（§5 の tail10 で並べる）。
- 抽出は model の出力の誤りで失敗することがある（試運転 5 で 1/18、合成の参照の書き損じ）。失敗した Scene は除かずに件数を報告する。
- 第 1 版（OpenRouter の gpt-6-luna）、試運転 6・7（Anthropic の claude-opus-5-5）、第 3 版（claude-sonnet-5-5）は抽出の model が違うので、試運転の値を並べて比べない。
- m-ja-1（修正前の prompt、cache なし、3 地点、D=10.84 ms の build）と m-ja-2・m-en-1（#798・#799 の後、D=40 ms の build）は抽出の条件と build が違う。作品ごとに報告し、作品の違いと条件の違いを分けられない。
- 3 作品に絞ったので、作品の性質（文体・粒度）の幅は 6 作品より狭い。
- D=40 ms は製品の新しい既定値で、この測定の「IR が間に合わない」の割合はその値の下のもの。D を変えた理由の診断の値（§0 の 13）は、第 4 版の workspace の写しで測った別の測定で、この測定の結果ではない。

## 11. 道具と記録

- 位置 15 の authority の差し替え（試運転 3）は試運転 4・5 で再現しなかった。本番でも `GRIMODEX_WORKSPACE_OPEN_TRACE=1` を付け、main と renderer の出力のうち workspace／authority／recovery／restore／rollback の行を各 run の `workspace-trace.log` に残す。起きたら発生源を調べ、その Scene は失敗として数える。
- 道具の sha256（harness の commit `cdcce37e`。第 4 版から `ir-slot.mjs` と `ir-renderer.ts` だけが変わった。追加は `--reuse-workspace`（診断の mode）と、sample ごとの時刻の記録（`timing`）。本測定の経路では reuse の分岐も vite の変換も働かない）：
  - `ir-slot.mjs` `2811e9bf1ad4e357475cba55bcd6302bf3122375faa44b8fa07acbf867070c23`
  - `ir-renderer.ts` `97ef75f241657b944fd503b26853a27bd736367416b4a7b5fa90952ecd0dd566`
  - `ir-renderer.html` `a010188c470c99b68d80de1e416581bc6c590c103365c7d7ecbe80339ee97d3a`
  - `ir-classify.mjs` `a5599679eb23a1d9fc872bc82a722c80255de91f3fe3dbc92829dd71ca9a9a6b`
  - `raw-fullness.mjs` `1910808b5242214e1bcccd69f9a235424e3a70d8a8c80227e96fb9218de6f43f`
  - `fifo-key.mjs` `0584991d44f38eb9ad78d98fd0956d333d6683a5672ca1d16956f503009448b5`
  - `product-key-to-fifo.mjs` `b7ce156d2ba752aa835640127174a7ad347c9226b6fc56b59cb3462b8b27dbf1`
