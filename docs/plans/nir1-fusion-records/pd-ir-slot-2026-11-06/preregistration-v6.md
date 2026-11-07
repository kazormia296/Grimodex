# 事前登録（確定・第 6 版）：日本語の 2 作品（m-ja-2 と AI 原稿 g-ja-1）で IR が共通の 1 枠を使う割合

- 状態：**確定・第 6 版**（2026-11-06）。下書きの §6・§3 の 2 点はユーザーが確認した（§12）。確認の後に足したのは、失敗の記録の伏せの例外（固定の診断 code）、失敗の label の規則と分母の定義（§5）、集計 script と道具の sha256（§11）、build の値（§7）、build に入らない修正の記載（§10）で、測る内容・判断規則・閾値は変えていない。
- 取り直しの範囲：ユーザーが「日本語だけ取り直す」を選んだ（2026-11-06 00:17Z。ほかの選択肢は「日英とも取り直す」「英語の足切りを先に見直す」「取り直さない」）。対象は **m-ja-2**（PD、role `main`）と **g-ja-1**（AI に書かせた日本語の原稿、role `control-ai-gen`）。英語（m-en-1・g-en-1）は測らない。m-en-1 の「IR の候補 0 件」56/70 query は、全部が英語の足切り 0.66 未満で説明できたため（足切りを下げるのは閾値の変更で、委任の外）。
- 前の版：第 5 版（`preregistration-ir-v5.md`、sha256 `64e2bb1691e56c79e9173ec7efe5b0861e629deb57e6321fdc1f8129b99911dd`、contracts `d46a17e5`）。**この版で書いていないこと（抽出・承認・地点・query・指標・記録・隔離の方法）は第 5 版のまま**で、§1〜§6 の差分だけを書く。
- evidenceScope：**`not-cp4-evidence`**（CP-4 の証跡にも判定にもしない）。
- ユーザーの決定（送信先・費用・key）：第 5 版と同じ（contracts の `user-confirmation-2026-11-03-pd-raw-cloud-ir.md`、Anthropic を優先、key は製品の profile の key）。

## 0. 取り直す理由

1. 第 5 版の m-ja-2 は 117 Scene のうち **11 Scene の抽出が失敗**した（位置 53・65 は `Snapshot build failed: <long>`、57・68・72・83・91・99・101・111 は `SNAPSHOT_SOURCE_CHANGED`、107 は `Failed query（listEvents）`）。原因は、関連場面の IR の index build（prepare）が native の単一の接続を長く握り、renderer の read が 10 s で打ち切られたこと（reviewed revision が約 250 件を超えると prepare が 10 s を超えた）。`SNAPSHOT_SOURCE_CHANGED` は実際の変化ではなく、読込みの例外の付け替えだった（`docs/plans/nir1-lane-decisions/irb-decisions.md`）。
2. 修正（§7 の build に入る）：
   - #805（DR-IRB-1）：stage の receipt の audit の COUNT を scope の index で引く（全件走査をやめる。数える行は変わらない）。
   - #807（DR-IRB-4）：prepare の中で同じ Run の検証の結果を Root ごとに繰り返さず使い回す（1 回の read tx の中だけ。検証の意味・fail-closed・publish は変えない）。prepare は写しの DB で m-ja-2 が 10.4 → 7.4 s。
   - #806（DR-IRB-2）：snapshot の読込みの失敗を `SNAPSHOT_SOURCE_CHANGED` に付け替えない（IPC timeout と失敗した SELECT は `SNAPSHOT_SOURCE_READ_FAILED`）。**失敗の label が第 5 版と変わる**。
   - #808（DR-EWC-1）：根拠の目録の entry が抽出の窓の境目をまたいでどの窓にも入らないとき、その窓の context だけを entry の端まで広げる（今までは fail-closed で抽出が失敗した）。穴の無い入力の window plan は byte 同一。第 5 版の m-ja-2 には穴による失敗は無かった（m-en-1 で 2 件）。
   - #804（recovery の handoff の固定コード、pump の診断）と #803（docs）も入る。
3. 記憶の対照：ユーザーの問い（2026-11-05「AI が過去の名作を学習しているから、青空文庫だと評価として微妙では」）に対し、学習の締切の後に書かれた原稿（g-ja-1）を同じ harness・同じ分割規則で測り、PD の古典との差を見る材料にする。設計は `design-notes/ai-gen-memory-control-2026-11-05.md`、生成の記録は `ai-gen/GENERATION.md`（生成は 1 回、関連場面・IR・抽出の結果を見て選び直していない）。

## 1. 目的

第 5 版 §1 と同じ（関連場面の一覧で、Raw に無い Scene を足せる共通の最大 1 件の枠を IR がどれだけ使うか、Raw が 8 件満杯で枠が閉じていたときに IR の候補があったか）。加えて、**m-ja-2 と g-ja-1 の値を作品ごとに並べ、差を記述する**（記憶の対照）。

## 2. 作品

| key | role | 内容 | Scene | Scene の JSON の sha256 |
|---|---|---|---|---|
| m-ja-2 | `main` | PD の日本語の作品（第 5 版と同じ。段階 1 の `manifest.json` の `prepared`） | 117（711〜3,245 字、平均 1,716 字） | `e373a44318c4ea7b9f24cce359bdeb0eca408a4d8b8884928c4174a82976ec45` |
| g-ja-1 | `control-ai-gen` | AI（Claude Opus 5.5 の subagent）に書かせた日本語の長編『止めておくこと』。分割は同じ `scene-split-rules.json`（`dcfc704d…`）と `splitScenes` | 117（1,446〜2,226 字、平均 1,795 字） | `cf15a29b42d59ec34e2da8476c9d5fb30bc26fcadf5d348ef530f2275bbe3a49` |

- g-ja-1 の sha256 は `ai-gen/GENERATION.md` と `ai-gen/g-ja-1/manifest.json` に記録してあり、段階 1 の `manifest.json` には足さない（段階 1 の作品の目録を変えないため）。
- harness は role `control-ai-gen` を `main` と同じ gate（確定した事前登録の file と sha256 が要る）に通す（§11 の harness の変更）。

## 3. 抽出と承認

第 5 版 §3 と同じ（scope は案 B の製品の既定、Scene ごとに 1 回の抽出、Anthropic の `claude-sonnet-5-5`、key は製品の profile から FIFO、全提案を非 secret の child にして承認、apply しない、保守の cutover を待つ）。変えるのは次の 2 点だけ。

- **抽出の失敗の後、次の位置へ進む前に、native の接続が空くのを待つ（最大 120 秒）**。軽い読み（cutover の印の件数）が 1 秒以内に返る状態が 2 回続くことを「空いた」とする。上限に達しても記録して先へ進む。**成功の後は待たない**（第 5 版と同じ）。理由：第 5 版では 1 件の失敗の後も IR の build が接続を握ったまま次の位置の抽出が始まり、失敗が続いた（m-ja-2 の 11 件の多くは位置 53 以降に散らばる）。待つのは失敗の後だけなので、失敗の無い run の手順は第 5 版と同じ。
- **再試行はしない**（第 5 版と同じ）。`SNAPSHOT_SOURCE_READ_FAILED` を含め、失敗した Scene は除かず失敗として数え、次の位置へ進む。

## 4. 地点と query の選び方

第 5 版 §4 と同じ（25％・50％・75％・100％、query は各地点で足した Scene 全部〔位置 2 以上〕、各 query で hybrid を 3 回、probe、Graph は呼ばない）。両作品とも 117 Scene なので、query は各 116、sample は各 348（失敗した Scene も query には入る）。

## 5. 指標

第 5 版 §5 と同じ定義（`ir-classify.mjs` の分類、主指標＝`kind:"ir"` の行がある ÷（IR ready かつ Raw が 8 件未満）、Raw 満杯で IR 候補あり、反実仮想、probe、前の Scene の数の層別〔<8／8〜30／>30〕、tail10）。

- **作品ごとに出す**（m-ja-2、g-ja-1）。両作品を足し合わせた値は出さない（PD と対照は別の母集団）。
- **記憶の対照として並べる値**（作品ごと）：抽出の完了数と失敗の形、提案の数と significance・actuality の分布、主指標、Raw の満杯率、Raw 満杯で IR 候補あり、IR が空の割合、層別、tail10。**差は記述するだけで、検定や採否の閾値は置かない**（query は独立でなく、作品は 1 つずつ）。差は g-ja-1 − m-ja-2 の値の差。
- 分母の定義（集計 script の出力の `definitions` にも同じ文を持たせる）：Raw の満杯率＝Raw が 8 件の sample ÷ 全 sample。IR が空の割合＝枠を使わなかった sample のうち IR の admitted が 0 件のもの ÷ 全 sample（Raw の満杯と重なりうる）。提案の数の Scene あたり＝提案の合計 ÷ 抽出が完了した Scene。主指標・Raw 満杯で IR 候補あり・層別・tail10 は第 5 版と同じ。
- 失敗の形：第 6 版の harness は、製品の固定の診断 code（`SNAPSHOT_`／`NEX_` で始まる大文字の語）を 32 字以上でも伏せない（第 5 版では `SNAPSHOT_SCOPE_VALIDATION_FAILED`〔32 字〕が `<long>` に伏せられ、m-ja-2 の位置 53・65 の原因を分けられなかった）。複数の code が並ぶ失敗は、code を辞書順に連結した label で数える。label の規則（集計 script の `shapeKey`。測る前に固定）：`Failed query` で始まる失敗は `Failed query`、根拠の目録の穴は参照 ID を落とした `Evidence span catalog coverage hole` に先に決める。それ以外は固定の code（`SNAPSHOT_`／`NEX_`）を重複を除いて辞書順に連結し、最初の code の前の文言を頭に付ける（文言が無ければ `(code)` と code の後ろの文言の先頭 40 字）。最初の code より後ろに `<long>` があれば末尾に `<long>` を足す。errorShape が無ければ `(なし:errorCode)`。harness が 240 字で切った失敗は、切れた末尾の code を label に入れず、位置を `extractionTruncatedShapes` に別に出す（切れた後ろの code は label から落ちうる）。第 5 版の label からの変更は 2 点（m-en-1 の穴の 2 件を 1 つの label にまとめる、`Failed query（listEvents）` を `Failed query` とする）で、第 5 版の records で数値と位置が変わらないことを試験で確かめた。
- 第 5 版の m-ja-2 との比較：同じ位置・同じ件数の観点で並べる（失敗の label は #806 で変わったので、label どうしでは比べない）。

## 6. 判断規則

閾値は第 5 版と同じ（D0 は 200、D1 は 5％。緩めない）。**どの母集団に課すか**を次のとおりにする（§12 の 1、ユーザーの選択）。

- **主指標の pooled（参考）**：第 5 版と同じ 3 作品の組で、m-ja-2 だけを第 6 版の値に置き換える（m-ja-1 は第 3 版、m-en-1 は第 5 版のまま）。D0・D1 はこの pooled に課す。置き換えは第 6 版の値を見る前に決める（値が第 5 版より良くても悪くても置き換える）。第 5 版の m-ja-2 の値は記録として残す。
  - 見込み（推測）：第 5 版の D0 の分母は m-ja-1 78＋m-ja-2 90＋m-en-1 51＝219。第 6 版の m-ja-2 が同じ程度（約 90）なら約 219 で D0 に届く。m-ja-2 だけでは 200 に届かない（第 5 版で 90）。
- **g-ja-1**：pooled に入れない。D1（IR 未構築・故障の合計が全 sample の 5％ 超）を作品ごとに課し、超えたら g-ja-1 の値を対照として読まない（件数は報告する）。D0 は課さない（作品が 1 つで 200 に届かない見込みのため。値は記述として出し、結論は出さない）。
- **m-ja-2 の作品ごとの D1**：同じく作品ごとに課す（第 5 版は 0）。
- 停止の規則（第 5 版 §0 の 10 と同じ）：1 作品目（m-ja-2）の最初の 5 Scene の抽出で 3 件以上失敗したら止めて原因を調べる。
- 枠の案の採否の閾値は置かない。採否はユーザーが結果を見て決める。

## 7. 記録と隔離

第 5 版 §7 と同じ（記録の項目、本文・題名・抜粋・LLM の応答の本文を書かない、置き場所 `runs-ir/`、隔離の env、`GRIMODEX_WORKSPACE_OPEN_TRACE=1`、送信先は Anthropic の API だけで PD の本文と AI 原稿の本文だけを送る）。違うところ：

- 失敗の記録に、失敗までの時間（`failedAtMs`、discard の前に取る）、discard の時間、原因の鎖（`errorChain`：種別・code・伏せた message を error 自身と cause の 3 段まで）、接続の待ち（`connectionWait`：ready、待った時間、poll の回数、最後の状態）を足す。message の伏せ方は第 5 版と同じ規則に、params 以降の切捨てと引用部（`"..."`、`'...'`）の伏せを足し、製品の固定の診断 code（`SNAPSHOT_`／`NEX_` で始まる大文字の語に完全一致するもの）だけを長い英数字列の伏せの例外にしたもの（code は語彙が固定で本文を含まない。英語の作品の本文が ASCII のまま残らないための伏せは変えない。今回は日本語だけだが道具は同じ）。
- 実行環境：**build-ir-24**（受領書 `/home/grimodex/fusion-eval-data/pd-2026-11/build-ir-24/standard-build-receipt.json`。head `9930ab645ee5524c0fd99eb3b0eb2bd7d4c4eb89`〔harness の第 6 版の commit〕、base `d8823f654d6372e08fa65fa460d7f65be3467fa1`〔master、#807 の merge〕、tree `b7b237148db777ba19823b27494beafe88b873de`、worktree clean、受領書の sha256 `9c1dc011c2be4f9744e7133b822a5b1311c2886fb96c44f94533a3232865a3ed`。native の `grimodex-node.node` は `78428f97…`）。
- 起動の script：`run-ir-main-v6.sh`（m-ja-2 → g-ja-1 の順に作品ごとに別の process。出力は `runs-ir/main6-*`。worktree は `claude-fusion-ir-eval-v6`。HEAD・clean〔filter なしの `git status --porcelain` が空〕・事前登録の sha256 を照合してから走らせる）。
- run の間は評価の worktree を触らない（第 3 版の中断の教訓）。また、IR の build の prepare は同じ machine の CPU を使うので、run の間は integrator が同じ machine で cargo の build・試験などの重い job を走らせない（run の開始の前に終わらせる）。

## 8. 費用と時間（推測）

第 5 版の m-ja-2 の実測：2026-11-05 09:24Z〜11:56Z（約 2.5 時間）、usage は入力 約 106 万・出力 約 52 万 token（usage の取れた 1,452 回分だけ。2,953 回は usage が記録に無いので下限）。Sonnet 5.5 の公表の単価（入力 $2／出力 $10 per 1M）で下限 約 $7。g-ja-1 は Scene が少し長い（平均 1,795 字 対 1,716 字）。2 作品で **約 5〜6 時間、下限 約 $15**（usage の欠けを見て $15〜$40 の幅）。

## 9. 試運転

行わない。経路は第 5 版の本測定と同じで、変わるのは build（§0 の 2）と harness（失敗の後の待ち、失敗の記録、role の gate）。代わりに §6 の停止の規則で最初の 5 Scene を見る。harness の変更は `node --test` の試験で確かめる（§11）。

## 10. この結果で言えないこと

第 5 版 §10 のうち日本語の作品に関わるものはそのまま当たる（全提案を非 secret で承認した「IR が最大に出る条件」の値、Codex が無い、probe は floor 通過後だけ、Graph は測らない）。加えて：

- **g-ja-1 と m-ja-2 の差を、記憶の影響だけに帰すことはできない。** 文体と時代（PD は古典、AI の原稿は現代の文体）、構造（LLM の長編は単調になりやすい、人物・場所の再登場の頻度が違いうる）、Scene の長さ、書き手と抽出が同じ系列であること（自己選好）が交絡する。作品はそれぞれ 1 つ。交絡の少ない対照（同じ作品の固有名の置換）は今回は行わない。
- g-ja-1 には軽微な一貫性の食い違いが約 25 件残る（重大 5 件だけを直した。`ai-gen/g-ja-1/consistency-check.md`）。
- 失敗の後の待ちを入れたので、失敗が続く run の手順は第 5 版と違う。第 6 版の m-ja-2 の失敗の数が減っても、build の修正の効果と待ちの効果は分けられない（失敗の時刻と接続の待ちの記録で、どちらが効いたかの手がかりは残る）。
- pooled の主指標は、抽出の条件も build も違う 3 作品（m-ja-1 は第 3 版、m-en-1 は第 5 版、m-ja-2 は第 6 版）を足したもので、参考にとどめる（第 5 版と同じ扱い）。
- build に入るのは DR-IRB-4 までで、prepare の残りの短縮（finalize の Freshness の読みの共有。DR-IRB-6 の候補として調査中）と専用の読取接続（DR-IRB-3）は入らない。写しの DB で m-ja-2 の最終の時点の prepare は約 7.4 s（renderer の read の期限は 10 s）。reviewed revision が増える後半で抽出の失敗が残れば、その記録（失敗までの時間、接続の待ち）を次の修正の材料にする。
- 英語は測らないので、英語の対照（g-en-1）の値は無い。英語の IR が空になりやすいのは足切り 0.66 によるもので、この版では扱わない。

## 11. 道具

- harness：branch `claude/fusion-slot-ir-eval-v6`。第 5 版（`cdcce37e`）からの変更は、`ir-error-record.mjs`（失敗の記録・伏せ・接続の待ちの純関数、新規。固定の診断 code を伏せない）、`ir-renderer.ts`（失敗の後の待ちと記録）、`ir-slot.mjs`（道具の sha256 の一覧に `ir-error-record.mjs` を足す、log の行）、`raw-fullness.mjs`（role `control-ai-gen` を本番と同じ gate に通す）。`ir-classify.mjs`（分類の正本）は第 5 版と同じ。harness の commit は `9930ab645ee5524c0fd99eb3b0eb2bd7d4c4eb89`（master `d8823f65`〔#807〕を merge したもの）。道具の sha256：
  - `ir-slot.mjs` `de72042122d3b30080b28f43aa93533a54e0c7c4bc82f3054051144cfce34503`（変更）
  - `ir-renderer.ts` `45757b943158ca1b1118ccdf4656d137f4d055709609a5735f3db7d0d9b6f95b`（変更）
  - `ir-renderer.html` `a010188c470c99b68d80de1e416581bc6c590c103365c7d7ecbe80339ee97d3a`（第 5 版と同じ）
  - `ir-classify.mjs` `a5599679eb23a1d9fc872bc82a722c80255de91f3fe3dbc92829dd71ca9a9a6b`（第 5 版と同じ）
  - `ir-error-record.mjs` `d99a87be31b4b873d459fb3517fdfdb58fab1511756dfdd369132e5f9aca078a`（新規）
  - `raw-fullness.mjs` `c63a9c3c523f5fcba54edb782d7b0b66f3d4d22c5b0588cf94512b7b42bc101e`（変更）
  - `fifo-key.mjs` `0584991d44f38eb9ad78d98fd0956d333d6683a5672ca1d16956f503009448b5`（第 5 版と同じ）
  - `product-key-to-fifo.mjs` `b7ce156d2ba752aa835640127174a7ad347c9226b6fc56b59cb3462b8b27dbf1`（第 5 版と同じ）
- 集計：contracts の `docs/plans/nir1-fusion-records/pd-ir-slot-2026-11-06/scripts/agg-v6.mjs`（第 5 版の集計と同じ `summarizeQueries` を使い、第 5 版の records で第 5 版の値を再現することを試験で確かめる）。contracts の commit `a5924bf03604f8dfd76525f9cd30edd5419fe3b9`、`agg-v6.mjs` の sha256 `f18ce739689861b1fca231ed54ef1684def07ae48033181edaddede80753f22c`（試験 33 件）。
- 試験：`node --test scripts/quality/fusion-slot-eval/*.test.mjs`（失敗の記録・伏せ方・接続の待ち・role の gate を含む）。

## 12. 確認の結果（2026-11-06）

1. **判断規則を課す母集団（§6）**：ユーザーが「3 作品の組で m-ja-2 を差し替え（推奨）」を選んだ。第 5 版と同じ 3 作品の pooled で m-ja-2 だけを第 6 版の値に置き換え、D0・D1 をそこに課す。g-ja-1 は pooled に入れず、D1 だけを作品ごとに課す（ほかの案「第 6 版の 2 作品だけで数える」「合算を出さず作品ごとだけ」は選ばれなかった）。
2. **失敗の後の接続の待ち（§3）**：ユーザーが「待ちを入れる（推奨）」を選んだ（ほかの案「待たない（第 5 版と同じ）」は選ばれなかった）。
3. **再試行しない（§3）**：第 5 版と同じ（変更なし）。
