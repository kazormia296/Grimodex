# 実製品の chat で IR は質問に効くか — pilot の設計と事前登録の下書き（v2）

状態：下書き（レビュー 38 件で v1 を改訂）。ユーザー確認の前で、API は 1 回も呼んでいない。**`[precheck]` で停止中**：0 の確認が済むまで、API 呼出し・Gold の生成・Electron の起動・DB の複製は行わない。事前登録の確定（v3 以降）と hash 固定は 9 の回答の後。
日付：2026-11-07。基点：origin/master 73c48507（製品コードは git show で読んだ）。
表記：[確認済]＝DB またはコードを read-only で確認、[推測]＝計算または仮定、[未確認]＝まだ見ていない。
規則：原稿の本文・質問文・Gold・回答・IR の statement と quote は repo に入れない（7.4）。この文書も本文を含まない。

## 改訂の履歴

- v1（2026-11-07）：初版。
- v2（2026-11-07）：レビュー 38 件を反映。主な変更（括弧内は指摘番号）。
  - 0 を新設：外部送信の precheck、送信内容の表、停止点、NIR-1 の事前委任は適用外（29、32、33、36、38）。
  - 1：「製品判断に使わない探索」に統一。結論の読み方と「結果パターン→判断」の表（18、21、37）。B は DD route の request ではないと明記（20）。
  - 2：決定した 4 arm（A・B・C・D）は維持し、識別のための追加 arm を 3 層に分けて確認へ回す（0、A_s、A′、A″ ほか。1、7、19、20、22）。IR の選び方は製品の compiled policy に揃える（22）。位置表記の非対称を分ける（3）。D−C と B−A は別の量（2）。seed から定型句を除く（14）。prefix の byte 一致（25）。
  - 3：地点を 59・117 に絞り、p=30 は Haiku の通し専用の別の質問集合に（9、17）。型×根拠 Scene 数×根拠の位置の層化、自然な聞き方、矛盾検出系の問い、N 型は後の Scene だけ（4、5、6、23）。Gold の新設の確認と人の標本確認の必須化（5、30）。
  - 3.4：DB の切り方を手順にし、漏れの検査を gate に（15、24、34）。
  - 4：採点の盲検、ヘッジ規則、arm 別・長さ別の一致率、別系列の judge（10、13、27）。
  - 5：主指標を 1 つに固定、反復で noise floor を測る、同値の幅は置かない、通しの結果では設計を変えない（8、9、11、12、26、31）。
  - 6：工程別の見積り（実装の手間を含む）、出力 token の 3 水準、cache 前提（25）。
  - 7：正本は renderer の composition、再利用する資産の表、ダンプ・ログの権限、API の干渉（24、28、33、35）。
  - 9：問いを再編（Gold の新設、送信の個別許可、arm の拡張、別系列、API 干渉など）。

## 0 precheck（GDX-PRECHECK-001）

この pilot は外部送信（原稿の全文・IR・質問・Gold・回答を Anthropic へ）、長時間の並列実行、prompt cache、Electron の subprocess を含む。AGENTS.md の NIR-1 残レーンの事前委任（技術判断・脅威モデル改訂）は、この pilot の lane に及ばない。**適用外**とし、ユーザーの確認が済むまで `[precheck]` で止まる。

### 0.1 actor・送信先・データ・保持・停止点

| 項目 | 内容 |
|---|---|
| actor | 評価 harness（別 process の Node script）、Electron の renderer と main（A の文脈のダンプだけ）。評価用の keyring の Anthropic key（値は表示・記録しない） |
| 送信先 | Anthropic Messages API（既存の送信先）と、同じ API の count_tokens（別 endpoint の呼出し）。OpenRouter は 9 の Q の承認があるときだけ（0.3）。それ以外は無し |
| 送らないもの | key、profile、製品の他のプロジェクトのデータ、p 以降の Scene（Gold 生成の N 型の Opus 呼出しを除く。0.2 の行 b） |
| 保持 | Anthropic 側の prompt cache（ephemeral、5 分 TTL）。repo の外の保存（0.4）。repo には件数・enum・全体 hash 1 個だけ（7.4） |
| subprocess・並列 | Electron は別 userData で DB ごとに 1 回（10 問をまとめて処理）。API の並列度は 0.5 |
| 停止点 | 0.6 |

### 0.2 送信内容の表（送信内容×model×段階×作品）

g-ja-1 は AI が書いた原稿、m-ja-2 は公有原稿（記憶の交絡あり）。「既存」は、抽出などで既に Anthropic へ送った範囲と同じ種類のもの。「新規」の行は、ユーザーが個別に許可する（9 の Q1）。

| 行 | 送信内容 | model | 段階 | 作品 | 区分 |
|---|---|---|---|---|---|
| a | Scene 本文（単独） | Sonnet 5.5 | 抽出（実施済み） | g・m | 既存 |
| b | 位置 p までの全文＋質問生成の指示。N 型だけは後の Scene も | Opus 5.5 | Gold 生成 | g・m | 新規 |
| c | 根拠 Scene 全部＋質問（Gold 検証） | Sonnet 5.5 high | Gold 検証 | g・m | 新規 |
| d | 位置 p までの全文を 1 request にまとめた chat（C・D） | Sonnet／Haiku 5.5 | 回答 | g・m | 新規（cache の一時保持を含む） |
| e | chat の system（Raw の chunk、IR の statement と quote、current_scene）＋質問（A・A_s・A′・A″・B・0） | Sonnet／Haiku 5.5 | 回答 | g・m | 新規（内容は既存の延長） |
| f | Scene < p の synopsis 生成の入力（A_s のみ。Scene 本文） | Haiku 5.5 | 前処理 | g・m | 新規（A_s の承認時） |
| g | 質問・Gold の項目・回答（judge）。IR 由来の誤答 label では IR の event も | Haiku 5.5 low、Sonnet 5.5 high | 採点 | g・m | 新規 |
| h | 同上、A・B のみ（自己一致の確認） | Opus 5.5 | 回答（区切り 1 回） | g・m | 新規（9 の Q） |
| i | token 数の測定（全文 prefix、IR、Raw） | count_tokens | 事前実測 | g・m | 新規（別 endpoint） |
| j | 質問・Gold・回答のみ（標本）。Scene 本文は送らない | 別系列（OpenRouter、gpt-6-luna） | judge・Gold 検証の標本 | g・m | 用途拡大（承認制。推奨しない） |

- cache の保持：d の全文 prefix は Anthropic 側に最大 5 分（TTL）残る。TTL の延長（1 時間 cache）は使わない。
- hash の粒度：質問集・Gold 集・回答集のファイル全体に 1 つずつだけ取る（0.4、7.4）。

### 0.3 別系列の model（OpenRouter）

OpenRouter は既存の評価の送信先（2026-11-06 の precision-gold の事前登録で gpt-6-luna に同じ 2 作品の Scene 本文を送る決定済み）。ここで使うのは新しい送信先でなく、既存の送信先の用途拡大に当たる。承認が要る範囲は表の行 j（質問・Gold・回答の標本のみ。原稿は送らない）。承認が取れなければ、Gold の生成者・judge・回答がすべて Anthropic 系列である限界を結論に残す（8-7）。推奨はしない（評価の API は Anthropic 優先の方針）。

### 0.4 保存の量・期間・削除

- 保存先：/home/grimodex/fusion-eval-data/ir-chat-pilot-2026-11/（repo の外。権限 0700）。
- 想定サイズ [推測]：複製 DB は 6〜8 個で数百 MB 以内、request の全文ダンプは約 800〜1,000 件で数 GB（全文 arm が大半）、回答・Gold は数十 MB。
- 保持：記録の完了まで。完了後 30 日で、全文ダンプと複製 DB は削除（または圧縮して退避）。質問集・Gold 集・回答集は残す（本文を含むので repo には入れない）。
- 保存範囲の拡大にあたるかは、判断をユーザーに任せる（9 の Q）。

### 0.5 API の干渉と資源

Anthropic key・org の rate limit・費用は、他の run（IR 評価、CP-4）と共有される。

- 開始前に、他の run が走っていないことを確かめる（CP-4 の正式 run、IR 評価、第 6 版の harness のプロセスと API 呼出し）。
- 並列度と token／分の上限を事前に決める：全文 arm は同時 2 request まで、小さい arm は同時 8 まで [推測、v3 で固定]。rate limit の実値は [未確認]。専用の key か時間帯の分離を 9 の Q で聞く。
- 429 が出たら即時に並列度を半減し、続けて 2 回出たら停止する。第 6 版で時間切れ 33 件が観測されている。
- 資源の preflight（手順 2）：CPU・メモリ・ディスクの空きを確かめる。Electron の renderer と ONNX の embedding の同時実行は避け、直列にする。

### 0.6 停止点

次のどれかが起きたら停止して相談する：0 の確認が未了、0.2 の新規の行に許可の無いもの、費用が上限（9 の Q）に近づく、429 の連続、他の run との干渉の疑い、複製 DB の漏れ検査（3.4）の不一致、golden の不一致。

## 1 目的と、この pilot で言えること・言えないこと

### 1.1 目的

ユーザーの関心は「実製品の chat で、質問に対して IR が有効か」。ここでの IR は、第 6 版で build した Chronicle の event 提案（NIR-1 の Narrative IR。抽出から作る、根拠の位置つきの構造化した索引）。
今の製品の chat に IR は入っていない。IR を request に入れる経路は閉じている（`NIR1_LOCAL_GENERATION_UI_ENABLED=false`）。評価専用の経路で「IR を足した chat」と「足さない chat」を同じ質問で比べる。製品コードは変えない（7.2）。

### 1.2 結果の扱い

- 結果は**製品判断の入力に使わない**。次の事前登録を設計するための探索（not-cp4-evidence、PUB-G の証拠ではない）。v1 にあった「3 つの製品判断を動かす」は撤回する。
- 結果を判断に使うなら、9 の Q の回答をもらったうえで v3 で固め直す。
- 参考として、結果のパターンが「次に何を設計するか」をどう動かすかを 1.5 に表で置く（数値の閾値は置かない）。表の採用は 9 の Q で確認する。

### 1.3 言えること

- 条件つきの主張：「g-ja-1 と m-ja-2 の 2 作品、各 2 地点（59・117）、Sonnet 5.5／Haiku 5.5 で、**Chronicle event IR のブロックを足した効果（文脈量・検索単位の違い・quote の追加を含む）**の推定値と区間」。追加 arm（A′・A″）が承認されて実施できたときだけ、効果を量・検索位置・要約と構造に分けて書く。
- 4 arm のままの場合、結論に「IR の効果」とは書かず、上の太字の言い方を使う。「story_so_far なしの下限に対する増分」とも書く（A_s が無い場合）。
- 質問の型・根拠 Scene の数・IR の対応の有無ごとの差の記述（型別が主、総合は参考。5.1）。
- 誤答のうち「IR に引きずられた誤り」の件数（LLM と人の確認つき。4）。

### 1.4 言えないこと（結論に書かない）

- 「IR 一般」の効果。今ある IR は Chronicle の event だけ [確認済：両 DB とも codex_entries／codex_relations／events は 0 行、proposal は chronicle.create-event@1 のみ]。製品の IR route が送る accepted-ir は typed Entity／Relation で、nir1_packing.rs に chronicle の語は 0 件。**この pilot の Chronicle event IR は、その route が送るものではない**。
- 製品が将来 chat に入れる IR と同じ効果。**B は A への上乗せで、DD route の request ではない**（2.3）。route の packing（Raw と IR を同じ予算で選ぶ効果）は測らない。結果が示すのは「上乗せの情報価値」まで。
- 窓が小さい local model で、IR が圧縮として効くか（Sonnet／Haiku は窓 1M）。
- agent の tool を使った製品の agent モードの力（ユーザー決定で arm から外した）。
- 製品の実利用（synopsis・codex・plot thread・chronicle snapshot が入った文脈）。評価 DB は空で [確認済：g-ja-1 の synopsis 0、codex 0、events 0]、A は製品の標準より薄い下限（A_s で補う提案は 2.7）。
- 鮮度（fresh 状態だけ）と枠の大きさ（N 固定）の効果。変数にしていない。
- 作品をまたぐ一般化。作品は 2、cluster（作品×地点）は 4。「この作品群の中での結果」と書く。
- 合格ライン・採否の閾値・同値の幅（置かない。5.5）。
- 事実 QA は、執筆支援（製品の route の purpose は writing／review）の proxy にとどまる。3.2 に矛盾検出系の問いを加えるが、proxy であることは変わらない。

### 1.5 結果の読み方と「結果パターン→判断」の表

読み方（先に固定）：

- 全提案を承認した最大条件の IR は、製品の既定の packing より IR に楽観的な側に偏る（8-2）。
- B が A（と A_s）を上回らなければ、最大条件でも効かないので**強い負の結果**。
- 上回れば「上限の目安」であって、製品の効果ではない。

向きだけの表（数値の閾値なし。これは「次の設計の優先順位」で、製品判断ではない）：

| パターン | 次に設計を進める先 |
|---|---|
| E・O 型で B>A、S・R・K 型で悪化の推定が見えない | Chronicle event の描画規則の設計を次の lane の候補にする |
| D<C で、IR 由来の誤答が増える | 描画の前に summary の忠実性対策（FABLES／COSMIR 系）を設計する |
| B≈A かつ D≈C | Chronicle event IR の chat 送出の優先を下げる |
| B>A でも B≈A′ か B≈A_s | 効果は IR 固有でなく量か synopsis で説明できる。IR の優先は上げない |
| 検索の hit が低く、hit したときだけ B が効く | IR の中身より検索側の設計（query・seed・floor）を先に見る |

動かさない判断（この pilot の結果は影響しない）：鮮度の扱い、枠の大きさ、PUB-G、Entity／Relation route の採否、閉じた経路の開閉。

## 2 arm

### 2.1 共通の固定

[確認済] 製品の chat は、chatContextPreparationComposition.capture／prepare → prepareTurn → planChatContext → buildSystemPrompt（src/features/chat/contextBuilder.ts）の順で request を作る。通常は mode="chat"（agent の tool なし）。system は chatSystemBase（ja）＋データ層（project_info、story_so_far、current_scene、focus_subject、codex_entries、plot_thread_scenes、chronicle_snapshot、related_scenes、chat_history、conversation_summary）＋chatSystemDataBoundaryReminder。製品の base prompt に「資料の範囲で答えよ」という指示は無い。

arm 間で固定するもの：

- system の土台（chatSystemBase、DataBoundaryReminder、tag 構造）は、製品の buildSystemPrompt の出力をそのまま使う（自前の再実装はしない）。
- history なしの単発（1 質問 1 request）。user message は質問本体と、その後ろの別の 1 文（定型句）だけ。
- **定型句**（「ここまでに書かれた範囲で答えて」の趣旨）は、質問本体と分けて user message の別の文として添える。検索の seed は定型句を除いた質問本体で作る（14）。製品の prompt に無い定型句は、文脈が少ない arm で棄権を強めうるので、arm 別の棄権率を報告する（5.1）。定型句なしの版との差は Haiku の通しで見る（探索）。
- answer model・thinking／effort・max_tokens は段階ごとに固定して事前登録する。
  - Haiku 5.5 は effort low、Sonnet 5.5 は effort high。thinking は adaptive のみ。effort は output_config.effort。
  - **temperature 等の sampling 引数は送らない**（Sonnet 5.5／Haiku 5.5 は非既定値を拒否する。事前登録に「送らない」と書く）。回答は run ごとにばらつくので、5.3 で反復して noise floor を測る。
  - max_tokens は製品の outputBudget（src/features/ai-context/outputBudget.ts の resolveOutputBudgetPlan）の算出に合わせ、thinking が max_tokens を消費する余裕を確かめて固定する [未確認：値は v3 で確定]。
- 現在 Scene：Scene p の本文を current_scene として全 arm に入れる。
- IR は Scene p を除き Scene < p のものだけ。Gold の根拠も Scene < p だけ（3.4）。
- arm ごとに変えるのは、related_scenes の中身、IR の block、前の全文の block、story_so_far だけ。

評価環境の位置の再現：作品ごとに DB の複製を Scene ≤ p に切った 4 個（2 作品×2 地点）＋通し用の 2 個（p=30）を作る。複製と切り方の手順は 3.4。

### 2.2 arm 一覧

層 1 は決定済み（ユーザー決定 2026-11-07）。層 2・層 3 は識別のための追加で、決定の変更になるので 9 で確認する。

| 層 | arm | 内容 | 目的 |
|---|---|---|---|
| 1 | A | 製品相当の Raw（related_scenes） | 基準線（story_so_far なしの下限） |
| 1 | B | A＋Chronicle event IR ブロック | 主の対象 |
| 1 | C | Scene < p の全文 | 上限の目安 |
| 1 | D | C＋IR | 注意誘導・妨害の効果 |
| 2 推奨 | 0 | 本文なし、質問だけ | 記憶・推測しやすさの床（両作品。7） |
| 2 推奨 | A_s | A＋story_so_far（Scene < p の synopsis） | 製品の長距離記憶の主経路を基準線に入れる（19） |
| 2 推奨 | A′ | A の seed の上位 chunk を、B の IR と同じ字数まで増やした Raw。ゲートは外す | 文脈量の効果（1） |
| 2 推奨 | A″ | B と同じ top-8 event の根拠段落だけを Raw で渡す（要約・構造なし） | 検索位置の効果と、要約・構造の効果の分離（1） |
| 3 任意 | B_route | route 忠実：current_scene 空、`<codex_entries>` に Raw＋IR を packing 順で並べる | route の形（20） |
| 3 任意 | B_q | IR の検索を質問本体だけで行う B | seed の影響（22） |
| 3 任意 | B2 | quote なしの IR | quote（Raw の断片）の混入（1） |
| 3 任意 | B_ord | IR の位置表記に Scene 序数を付けた版 | 序数メタデータの効果（3） |

分解の読み方（層 2 が揃った場合）：

- B−A″：要約・構造の効果。A″−A′：検索位置の効果。A′−A：量の効果。A_s は story_so_far による基準線の補強。
- 同系統の交絡（synopsis と IR はどちらも LLM の要約）は、A_s・B・B＋A_s の 3 通りで見て「IR の増分が synopsis で吸収されるか」として報告する。B＋A_s は層 2 の拡張。承認が取れた場合だけ作る。

### 2.3 arm A と arm B

arm A：

- 構成：project_info、current_scene（Scene p の全文）、related_scenes（場面の chunk の自動注入）。story_so_far・codex・chronicle_snapshot は評価 DB で空。
- related_scenes は製品の semanticRecall.ts の規則どおり [確認済]：seed＝質問本体＋現在 Scene 末尾 500 字。hybrid（dense 30 件＋FTS5 sparse 上位 10 件の RRF、RRF_K=60、救済マージン 0.05）。日本語は top-1 が 0.85 に届いたときだけ 0.80 まで拾う。最大 3 chunk、1 chunk 600 字。ゲートを通らなければ 0 件（製品と同じ挙動として記録する）。
- chunk の見出しは「### 抜粋: <sceneTitle>」で、**Scene の序数は付かない** [確認済：SemanticRecallChunk は sceneId・sceneTitle・chunkText・score。ja の見出しは src/prompts/ja/chatSystem.ts の semanticRecallScene]。評価 DB の sceneTitle が序数を含むかは [未確認]。手順 2 で確かめる。
- **A の正本は renderer の composition**（実 renderer で製品の関数を動かして system をダンプ）。自前の ONNX 検索は B の IR 検索と hit label の計算だけに使う。8 個の DB×各数問で、composition の related_scenes の chunk 集合と自前の再現が一致する golden を取り、一致するまで次へ進まない（24）。

arm B：

- A の request に IR の block を `<codex_entries>` の位置に追加する。
- **B は A への上乗せで、DD route（nir1_prepared_request.rs）の request ではない**。route は contextBuilder を通さない別の builder で、fixed_system_prompt（chatSystemBase＋空の `<current_scene>`＋`<codex_entries>`＋Reminder）と packing の items（raw と accepted-ir）、local model の context_window に依存する予算選択で組む。route では current_scene が空で、Raw は semanticRecall の related_scenes ではなく packing の raw になる。置き場所を `<codex_entries>` に合わせた点だけが route と一致する。route 忠実の形は B_route（層 3）。
- **IR の選び方（既定）**：製品の compiled policy（policies/narrative/nir1-related-scenes-ranking.json、electron/native/grimodex-node/src/related_scenes/ranking_policy.rs）に揃える [確認済：ja の IR cosine floor 0.813、IR 最大 8 Scene、Scene で dedup、statementRepresentation ordered-json/1、fusion raw-stable-one-supplement/1（Raw 最大 8＋追加 1）]。
  - 質問に対する Chronicle vector の cosine が 0.813 以上の event を、Scene で dedup（1 Scene あたり最高スコアの event 1 つ）して上位 8 Scene。Scene < p だけから選ぶ。
  - 閾値を新設しない（既存の floor を使う）。floor は typed statement 向けに較正された値の可能性があり、Chronicle vector の cosine 分布とは違うかもしれない。手順 2 で、floor を通る event 数の分布を LLM なしで見る。0 件の質問が多すぎれば、floor を変えず「IR 0 件の質問」として記録する。
  - top-8 無閾値は副（B_free、label として hit だけ計算。arm 化は 9 の Q）。
  - policy の statementRepresentation（ordered-json/1）と、event vector の serializer（chronicle-semantic-retrieval/1）が同一かは [未確認]。既存 vector と再埋め込みの cosine で先に確かめる。再埋め込みが既存 vector とほぼ 1 になることも確かめる（m-ja-2 の Scene 99 の 8 event は vector が無い [確認済：543／551]。同じ serializer で全 event を再埋め込みする）。
- **query の prefix**：event vector の document 側の prefix の実態を origin/master（src-tauri/crates/grimodex-semantic/src/spec.rs の prefix-v1 と runtime_nir1_documents.rs）で確かめ、質問側の prefix を製品の IR 検索（related_scenes/scoring.rs の query 側）と揃える。揃えた版と A と同じ「検索クエリ: 」の版の hit 率を LLM なしで比べて records に書く（16）。
- 検索 query は A と同じ seed（質問本体＋末尾 500 字）を既定とする。質問本体だけの B_q は層 3 と label（22）。
- 位置 p ごとに IR の index を作り直さない。event は Scene をまたがず、Scene < p で切れば位置 p の時点の集合と同じ [確認済：1 Scene 1 run、existingEventsCatalog は空]。
- 参照実装との照合：related_scenes/scoring.rs の挙動と、v6 の records（Raw 位置・probe の IR 順位と cosine）に対して、自前の実装の golden 照合を行う（22、28）。

### 2.4 IR の描画（評価専用。新設の規則）

製品の accepted-ir の描画は Entity／Relation 専用で、Chronicle event を chat に出す形は存在しない [確認済]。5 部分をそのまま写すと意味の無い JSON が混ざる。そこで次の形を提案する。

- 1 event を数行にする。構成要素（固定順）：
  - 位置：**製品の related_scenes と同じ粒度（Scene のタイトルのみ。序数なし）を既定**とする（3）。段落番号は付けない。Scene 序数と段落番号つきの版は B_ord（層 3）。C と D の「Scene N」見出しとは別の扱い。
  - summary（約 75 字）。
  - actuality／attribution／narrativeFrame（製品の Related Scenes が返す interpretation と同じ 4 項目）。
  - 人物の表層、場所、時間表現。ある場合だけ。
  - 根拠の quote（evidenceSet の全件。1 event あたり g 約 4.1 個×平均 23 字、m 約 3.4 個×平均 53 字）。
- event の並びは score 順でなく Scene の昇順。ただし位置表記が序数なしだと、昇順の並びは序数と同じ情報を与える。O 型の読みに影響するので、並びは score 順に固定する（序数の手がかりを並びから与えない）。
- 括りは `<codex_entries>`。current_scene や related_scenes と混ぜない。
- IR の量：8 event で約 1〜2.6K 字 [推測]。
- quote は Raw の断片で、「IR だけの効果」に Raw の追加が混ざる（量・quote・要約の同時変化。1.3）。分離は A″・B2。
- 描画の文言は評価専用で、製品の UI 文言や契約ではない。確定前にユーザー確認（新しい描画の新設に当たりうる）。

### 2.5 arm C：位置 p より前の生の原稿の全文

- Scene 1〜p−1 の全文を、製品の story_so_far の位置（current_scene の前）に 1 つの block として入れる。見出しは「Scene N」の素の番号だけ（タイトルや synopsis は付けない）。
- current_scene は Scene p。related_scenes は入れない（全文の部分集合なので）。この選択は事前登録に固定する。
- C と D は評価専用の人工 arm で、上限の目安として読む。
- 大きさ [確認済：原稿の字数。token は [推測]]：
  - g-ja-1：p=59／117 で前の原稿は 101,130／208,344 字（p=30 は 49,130 字、通し専用）。
  - m-ja-2：106,929／199,205 字（p=30 は 51,849 字）。
  - 1 prompt は位置 59 で約 100〜160k、117 で約 200〜310k token（日本語 1.0〜1.5 token／字の仮定）。1M 以内。実際は count_tokens で実測する。新 tokenizer の影響（旧比で約 30% 増の見込み）も込みで測る。
- **cache（C と D で prefix を byte 一致にして共有する）**：base＋project_info＋全文＋current_scene までを cache の prefix とし、C と D で同じ byte 列にする。IR・Reminder・質問は prefix の後ろ。D は C と同じ prefix の cache 読みだけで済む。
  - 各（作品×地点）で、最初の 1 呼出しで cache を書き、書込みの完了後に残りを並列にする。5 分 TTL を越えないよう、同じ prefix の呼出しをまとめる。
  - 製品の system は cache_control ephemeral の block を持つ [確認済]。
  - Haiku の全文 arm は 100K token を超えると高い単価帯に入る（6.2）。

### 2.6 arm D：C＋IR と、D−C・B−A の読み方

- C の request に、B と同じ手順・同じ描画の IR block（質問ごとの選択）を、原稿の後ろ（`<codex_entries>`）・質問の前に追加する。
- **B−A と D−C は同じ量を測らない**：
  - B−A は**情報補給の効果**。A は 1.8K 字ほどの Raw しか持たないので、IR は情報の追加になる。
  - D−C は**注意誘導と妨害の効果**。C には根拠の原文が全部入っているので、IR は情報の追加にならない。長文の中ほどにある事実の位置を示す効果と、重複や誤要約による妨害だけを測る。
  - 2 つの差が揃わないのは設計上当然で、「A と C のどちらを土台にしても同じか」は検証にならない。主指標として対称には扱わない（5.1）。
- D−C の主仮説は H2（D<C）。根拠 Scene が C の中ほどにある層とそうでない層（前方・直近）で比べる（5.2）。
- 「全 IR を C の前に年表として付ける」D′ は別の問い。今回は含めない。

### 2.7 追加 arm の説明（層 2・層 3）

- **0 arm**：m-ja-2 は公有の古典と見え、model が記憶で答えうる。g-ja-1 も AI が書いた原稿なので、典型的な筋・関係の推測や質問文の前提で、本文なしでも当たりうる。0 arm が無いと、A〜D のどの差も推測しやすさや記憶と区別できない。0 arm の正答率が高い項目（Haiku・Sonnet のどちらかが当てる項目）は、層別するか主指標から外す。規則は先に固定する（3.5）。H4 の「g-ja-1 の 0 arm は床に近い」は仮説でなく測定結果として書く。
- **A_s**：製品の長距離記憶の主経路は story_so_far（Scene の synopsis。generateSynopsisFromContent による AI 生成の導線がある）。A はこれが無いので「製品の標準より薄い下限」になり、IR の増分が過大に見える。A_s は、Scene < p の synopsis を製品と同じ generateSynopsisFromContent 相当の prompt で Haiku が別途生成して入れる（117 Scene 分で数セント）。synopsis は IR と同系統の要約だが、それは交絡の管理（上の 3 通りの比較）の話で、基準線から外す理由にはならない。送信は 0.2 の行 f。
- **A′**：A のゲートが閉じた質問では、v1 の A′（ゲートは A と同じ）も 0 件のままで量を揃える対照にならない。v2 では、**ゲートを外し、A と同じ seed の上位 chunk を B の IR の字数まで増やす**。
- **A″**：B と同じ top-8 event の根拠段落だけを原文のまま渡す。要約・構造の効果と検索位置の効果を分ける。
- 層 1 のまま（4 arm）で進める場合は、1.3 の言い方に従う。層 2 を増やすのは決定の変更なので、ユーザーが選ぶ。

## 3 質問と Gold

Gold の新設（質問集・項目ごとの Gold・型の配分・label）は「Gold の新設」に当たり、委任の外。**9 の Q2 の回答があるまで、手順 4（Gold の生成）に進まない**。この pilot の Gold は not-cp4-evidence として分離し、既存の Gold・台帳には触れない。

### 3.1 位置と件数

- **主の位置は p＝59 と 117**（約 50％と 100％）の 2 つ。両作品。p=88 は p=117 と量の差が約 1.3 倍で、地点の差が出にくい。p=30 は全文 arm がほぼ自明に有利で、IR の増分が見えにくい（17）。
- **p=30 は Haiku の通し専用**。各作品 10 問の別の質問集合を最初から分ける（9）。本測定の質問集合とは重ならない。
- 件数：各（作品×主の位置）20 問の LLM 生成＋人が書く質問 5 問（作品あたり 10 問）＝25 問×4 cell＝100 問。1 問は 2〜4 個の検証できる事実項目に分け、項目ごとに採点する（4）。地点を絞った分、1 地点の問数を増やした（cluster の設計効果は 5.4）。
- g-ja-1 は AI（Opus 5.5 の subagent）が書いた日本語原稿で、model の学習の締切の後なので記憶の交絡が小さい。ただし典型的な筋になりやすい（0 arm で測る）。m-ja-2 は公有の古典と見え、記憶で答えうる。主の分析は両作品を合わせ、作品別は記述。
- g-ja-1 の IR の欠け [確認済：抽出の失敗 10 位置（65、72、74、78、84、94、96、100、102、109）に、event が 0 件の Scene 36 を足した 11 Scene は IR 0 件]。前の Scene のうち IR 0 件の数：p=59 で 1／58、p=117 で 11／116。m-ja-2 は 117/117 完了で、event 0 件の Scene が 5（10、13、14、72、91）。
  - 欠けは今回の run の技術的な失敗で、IR という方式の性質ではない。**主を「根拠 Scene に IR がある層」にする**（label 1 が陽性。機械で付け、arm の結果を見る前に固定）。「全質問」を同格で併記し、IR が無い層の B−A は抽出失敗の影響として別に書く。
  - 層ごとの質問数は、質問を作った後でなく**配分の段階で見積もる**（各 cell で、根拠 Scene の IR 有りを 18 問以上になるよう配分する。g-ja-1 は欠けが前の Scene の 1〜9％なので足りる見込み [推測]）。
  - この「主の層」の選び方は 9 の Q で確認する。

### 3.2 質問の型・配分

位置 p の時点で、Scene < p で確立した事実だけを問う。

| 型 | 内容 | IR の対応 |
|---|---|---|
| E | 出来事の有無・当事者・場所 | 期待できる |
| O | 出来事の順（IR に story time は無く、順序は Scene の序数でしか表せない） | 期待できる（限定）。序数メタデータの効果と IR 内容の効果を分ける（2.4、5.1） |
| S | p 時点の状態 | 期待できない |
| R | 人物関係 | 期待できない |
| K | 誰が何を知っているか／まだ知らないか | 期待できない |
| V | 矛盾検出（「この設定はここまでと矛盾しないか」。review purpose に合わせた問い）。各位置 1〜2 問 | 未知（記述のみ） |
| N | まだ明かされていない事実（正答は「ここまででは分からない」） | 正答率の比較に入れない（下） |

A 型（actuality と frame）は件数が少なく（attempted 7、prevented 1）、IR の効果を測れないので配分に入れない。

- **N 型の事実は Scene p より後（>p）だけ**。Scene p の全文は全 arm の current_scene に入っているので、Scene p にある事実は N にならない。p=117 は Scene 117 が最後で、後の Scene が無いので N は 0 問（その分は E に置く）。
- **N は arm 間の正答率の比較に入れない**。文脈が少ない arm ほど「分からない」が自然に増えるので、比較にならない。報告は 2 つの対：(1) 答えられる質問での棄権率（arm 別）、(2) N での作話率（arm 別）。
- 提案する配分（p=59、20 問）：E 6、O 4、S 2、R 2、K 2、V 1、N 3。（p=117、20 問）：E 8、O 4、S 2、R 2、K 2、V 2。
- **根拠 Scene の数を軸に加える**：E・O の半数以上を根拠 Scene 3 以上にする。全体で 1／2〜3／4 以上の 3 層を、各 cell で最低 4 問ずつ。IR が Raw top-3 に勝ちうるのは複数 Scene にまたがる集約・変遷の質問で、単一 Scene の質問は Raw でも取れる（23）。
- **根拠 Scene の位置の層化**：前方（Scene 1〜p/3）、中盤、直近（p−5 以内）を割り当てる。生成者が目立つ場面や直近を選びがちなので、割当を prompt に固定する（4）。
- 総合値を主にせず、**型別を主**にする。配分を固定した重みつきの総合は参考として出す（5.1）。
- 配分の最終値は v3 で固定する。

### 3.3 作り手と独立性・検証

- Gold は原稿から作り、IR を入力に使わない（IR から作ると循環する）。
- 生成：Opus 5.5 に Scene 1〜p−1 の本文だけを渡し、型・根拠 Scene の数・位置の層を指定して質問・Gold の項目・根拠 Scene 番号を出させる。位置ごとに別の prompt。
- **質問文の書き方**（4）：原文の語句の転記を禁じ、作者が chat で聞く自然な聞き方（曖昧・口語・固有名の言い換え）に直させる。原稿の語彙を写した質問は FTS5 の sparse と dense の検索を当たりやすくし、A と B の検索を過大評価する。生成後、質問と原文の n-gram の重なりを機械で測り、基準を超える質問は直しに戻す（基準は v3 で固定）。
- **人が書く質問を各作品 10 問、必須にする**（作者本人。LLM 生成の「事実らしさ」の対照。取れない場合は結果に「人が書く質問なし」と明記し、結論を限定する）。
- 検証：Sonnet 5.5（high）に**全根拠 Scene を渡して**答えさせ、Gold と一致しない候補を棄却または見直す。単一 Scene で答えが決まる質問だけが残る偏りを避けるため、根拠が複数 Scene の質問も検証にかかる（5）。
  - **型別・根拠 Scene 数別の棄却数を records に出す**。
  - LLM 2 つの一致は Gold の正しさの保証にならない（Sonnet 自身の誤読と一致しうる）。**人による標本確認（30 問程度の抜き取り。型・根拠 Scene 数で層別）を必須にし、Gold の誤り率を結果に併記する**。不可なら結論を「Gold 未確認」と明記する。
- N 型だけは例外の手順：Opus が後の Scene（>p）を読んで事実を選び、質問は Scene < p の固有名だけで書く。検証は Scene < p だけを渡した Sonnet が「分からない」と答えること。質問に未来の固有名を入れない。
- Gold の生成者が g-ja-1 の書き手（Opus 5.5）と同系列である点は限界として書く（8-7）。別系列は 0.3。
- g-ja-1 の設計図（outline.md）は書き手の意図で、本文と食い違う軽微な矛盾が約 25 件残る [確認済：consistency-check.md]。候補の出所にとどめ、本文で検証した項目だけを Gold にする。

### 3.4 DB の切り方と未来の漏れの防止

複製の手順（元の run の DB は変えない）：

1. 対象の元 DB（runs-ir の下）が完了済みで書き手がいないことを確かめる：対応する run のプロセスが無い、-wal が空か無い、更新時刻が完了後で変化しない。
2. 元を**開かない**。-wal／-shm を含むファイルを copy する（元の SQLite を開く backup API・VACUUM INTO は元に lock や checkpoint を与えうるので使わない）。copy の前後で元ファイルの sha256 を取り、変化が無いことを確かめる。複製側で integrity_check を行い、件数を元の件数の記録と照合する。
3. 複製側で Scene > p を切る。消す対象は tree_nodes、scene_chunks とその embedding、FTS5 の sparse index、IR の proposal・vector・observation、その他 Scene 番号を持つ表（一覧は着手前に schema から作る）。FTS5 は rebuild する。dense の pool（30 件）と sparse の上位 10 件は、切った後の集合で作る。
4. 複製ごとに次を機械で検査する（**harness の gate。1 つでも不一致なら止める**）：
   - p 以降の scene ID が、全表・全 index で 0 件。
   - project_info の全項目（全体の梗概や後の章題が残っていないか）、章・Scene のタイトル、plot thread。
   - scene_chunks と FTS の行数と最大 Scene 番号。chunk の neighbors が p 以降を指さないこと。
5. Electron は DB ごとに 1 回起動し、10 問ずつまとめて処理する。

未来の漏れの防止（問いごと）：

1. 生成者には Scene 1〜p−1 の本文だけを渡す（N 型を除く）。
2. 各 Gold 項目の根拠 Scene 番号はすべて p 未満であることを機械で検査する。
3. 質問文に、p 以降にしか出ない固有名が出たら機械の語彙検査で棄却する。
4. 回答側の文脈は、切った複製から作る。
5. Scene p を current_scene として全 arm に入れる。Scene p の本文だけで答えられる質問は、label として記録し、除外しない（Scene p だけを渡した Haiku の closed 判定）。
6. m-ja-2 の N 型では、model が未来を知っているか（記憶）を測る。

### 3.5 事前の固定

- 質問・Gold・label・arm の定義・IR の描画・IR の選び方（policy）・seed・0 arm の扱いは、arm の結果を見る前に固定する。固定の記録は hash（sha256）だけを repo に入れる。
- IR の有無や IR の hit で質問を選別しない（label による層別は可）。
- **0 arm の規則（先に固定）**：0 arm の正答率が高い項目（Haiku・Sonnet のどちらかが 0 arm で「含む」と判定された項目）を「推測可」と label する。主指標は推測可の項目を除いた版を一次とし、含めた版を併記する。
- **通しの結果では arm・質問・描画・規模・主指標を変えない**。変えてよいのは bug と採点の規則の明確化だけ。それ以上を変える場合は別の事前登録とし、新しい質問集合で Sonnet を取り直す。ユーザーが決める。

### 3.6 label（選別でなく層別のために付ける。結果の前に機械で付ける）

1. 根拠 Scene に IR の event があるか（機械）。
2. その IR の summary が Gold の事実を含むか（Haiku low。入力は Gold 項目と IR の event だけ。LLM 判定で、誤りがある。人の標本確認つき）。
3. 検索の hit：A の chunk に Gold の根拠段落が入ったか、B の選択の根拠 Scene が Gold の根拠 Scene を含むか（機械。seed 2 通り）。
4. Scene p だけで答えられるか（3.4 の 5）。
5. 根拠 Scene の数（1／2〜3／4 以上）、根拠 Scene の位置（前方／中盤／直近）。
6. 推測可（0 arm の規則）。

## 4 採点

- 単位：項目ごとの 3 値（含む／矛盾する／言及なし）。矛盾（幻覚）は別に数える。N 型は「分からない」と述べれば正（棄権）、具体的な答えを述べれば矛盾（作話）。
- **ヘッジの列挙は矛盾とする**（複数候補を並べて Gold を含ませる回答は「含む」にしない）。規則を先に書き、C・D の長い回答に有利な偏りを防ぐ。
- **盲検**：採点の前に、回答から位置表記（Scene・段落の言及）と IR 特有の書式を除去する。judge と人の採点には arm 名を渡さない。B・D の回答に IR 由来の表記が残ると arm を推測できるため。
- 3 段：
  1. 固有名・数の逐語照合は機械。
  2. 言い換え・含意は judge（反復は Haiku 5.5 effort low）。入力は「質問・Gold 項目・回答」だけ。
  3. 区切りは Sonnet 5.5 high が照合。割れ・陽性・N 型は人または Sonnet で確認。
- judge と人の一致：全体で 60 項目では arm 別の偏りが見えない。**arm 別・回答の長さ別に標本を取る**（arm ごとに 15 項目以上、長さの層別）。κ と一致率に加え、**差の向き**（judge が人より寛容か厳密か。arm ごとに）を出す。κ の 95％区間は広い（60 項目で約 ±0.15 [推測]）。
- IR 由来の誤答の label（B・D で、IR の summary の誤りに引きずられた誤答）：意味照合が要るので機械ではできない。LLM（Haiku）と人の確認を前提にする。
- 自己選好：judge・回答・抽出・Gold がすべて Anthropic 系列だと、自己選好が一方向に効く。judge の別系列（OpenRouter）を**区切りの 1 回だけ**加える案を 9 の Q12 に置く（0.3。承認制）。
- 先行研究の裏づけの強さ：FABLES／COSMIR／Lost in the Middle／Adaptive-k は design-notes で照合済みとされているものだけ。Reading or Remembering は未照合で根拠にしない。判定の κ に関する LLM-as-a-Judge の心理測定は二次、PrivacyAlign は未照合で参考にとどめる。

## 5 指標と分析

### 5.1 主・副

- 質問の点数＝その質問の項目のうち「含む」の割合。
- **主（1 つ）**：Sonnet 5.5、両作品を合わせた、根拠 Scene に IR がある層（3.1）、推測可を除いた項目での、**B−A_s**（A_s が承認されなければ B−A）。対応のある差。
- 同格の併記：全質問での同じ差。
- **記述（副。検定の対象にしない）**：
  - B−A（A_s がある場合）、A′−A、B−A″、A″−A′（層 2）。
  - D−C（注意誘導と妨害）。B−A とは別の量（2.6）。主指標として対称に扱わない。
  - C−A、D−B。
  - 型別（E・O／S・R・K／V）、根拠 Scene 数別、根拠の位置別、作品別、model 別（Haiku、Sonnet）。型別・層別は「差の推定のみ」。
  - O 型は、序数メタデータの効果（B と B_ord の差。層 3）と IR 内容の効果を分けて書く。
  - 矛盾（幻覚）の率、棄権率と N の作話率、検索の hit 率（hit した場合・しない場合の正答）。
  - 配分を固定した重みつきの総合（参考）。
- 質問の分布は実際の作者の質問と無関係なので、総合の B−A に外的な意味は無い。型別が主。

### 5.2 仮説（採否の閾値ではない。差の推定の向きを見る）

- H1：E・O 型で B−A_s の推定が正の側にあるか、S・R・K 型で推定がどちらにあるか。**「悪化しない」「B≈A」の合否の語を使わず、差の推定値と区間を表で出す**。S・R・K は全体で約 40 問で、「悪化が見えない」は「悪化していない」の証拠にならない。同値の幅は置かない（5.5）。
- H2（D−C の主仮説）：IR の summary が誤っている項目で B と D の矛盾率が上がる。D<C が出うる（FABLES／COSMIR 系）。根拠 Scene が C の中ほどにある層と、前方・直近の層で比べる。
- H3：A と C の差は大きい。
- H4：0 arm の正答率（測定結果として書く。g-ja-1 は低いと見込むが、仮説として固定しない）。
- どれも検定に通れば採用、ではない。

### 5.3 区間・反復

- 対応のある二値は exact（符号検定）と Wilson 区間、連続値（項目の割合）は質問を単位にした bootstrap。cluster（作品×地点＝4）は記述で出す。cluster bootstrap は使わない。
- 推奨は差の推定値と区間（Miller 2024、Bowyer 2025、Fraile-Hernández & Peñas 2025。design-notes で照合済みのもの）。
- model ごとに別に出す。Haiku の数値は Sonnet に持ち越さない。
- **反復（noise floor）**：adaptive thinking では temperature を固定できず、回答はばらつく。Haiku は全 arm を同じ質問で 3 回、Sonnet は A・B（A_s がある場合は A_s も）を 2 回、全 arm 1 回に加えて走らせる。同じ arm の同じ質問の結果が割れる割合を test-retest の noise floor とし、B−A_s の区間と並べる。5.4 の不一致率 d にもこの揺れを使う。

### 5.4 検出力 [推測：McNemar 近似、両側 5％、検出力 80％]

- 独立な n 対で不一致率 d＝0.2 のとき、検出できる最小差は n=80 で約 14 pt、n=160 で約 10 pt。
- cluster の設計効果（ICC 0.05／0.1／0.2／0.3 で 1.45／1.9／2.8／3.7）込みの実効 n：主の層（約 80 問から推測可を除く。作品・地点が 4 cluster）で約 22〜55。d＝0.2 の最小検出差は約 19.5〜20 pt 以上。
- 型別・層別は検出力が無い（差の推定のみ）。地点を 4→2 に絞っても cluster 数を減らすだけで、設計効果は残る。
- IR の増分は数 pt〜10 pt の桁と見込み、検出できない見込みが高い。pilot の成果は「差の推定と区間」と、誤りの型・label 別の観察で、有意差の宣言ではない。

### 5.5 閾値

置かない。「何 pt 以上なら採用」「B≈A とみなす幅（同値・非劣性の幅）」は、閾値・Gold の新設に当たり委任の外。置くなら 9 の Q でユーザーが決める。費用の上限は停止の基準なので、数値と停止の動作をユーザーに確認する（9 の Q）。

## 6 規模・費用・時間・工程の見積り

すべて [推測]。実測の usage で上書きする。

### 6.1 規模

- 質問：主の 100 問（LLM 生成 80＋人 20）＋p=30 の通し 20 問。
- 4 arm のみ：400 request（Sonnet）。反復（Sonnet は A・B を 2 回目）を足して約 600。Haiku は 3 回で約 1,200。
- 層 2 まで（8 arm：A・B・C・D・0・A_s・A′・A″）：800 request。反復（A・B・A_s の 2 回目）を足して約 1,100。Haiku は 3 回で約 2,400＋通し。
- 全文 arm（C・D）の 1 prompt は位置 59 で約 100〜160k、117 で約 200〜310k token。

### 6.2 費用

価格 [確認済：claude-api skill の表。100 万 token あたり、入力／出力]：Haiku 5.5 は 100K 以下で $0.10／$0.50、100K を超えると $0.50／$2.50。Sonnet 5.5 は $2／$10。Opus 5.5 は $4／$20。cache の書込み 1.25×、読み 0.1×。Sonnet の長文脈の割増の有無は [未確認]。依頼文の Haiku 価格は 100K 以下の帯で、全文 arm は 100K を超える位置が多く 5 倍の帯に入る。

前提：prefix の合計（4 cell）は日本語 1.25 token／字で約 770k token（幅は 1.0〜1.5 で ±20％）。C と D は prefix を byte 一致にして cache を共有し、各 cell で書込み 1＋読み約 24（Sonnet）。**Sonnet の出力は 1 request あたり 2.5k／5k／10k token の 3 水準**（200〜300k の文脈で thinking high だと数千〜1 万超になりうる）で幅にする。

| 項目 | 4 arm のみ | 層 2 まで（8 arm） |
|---|---|---|
| Sonnet 入力：C・D（cache あり） | 約 $11（9〜14） | 同左 |
| 同（cache が効かない場合の上限） | 約 $55 | 同左 |
| Sonnet 入力：A 系の小さい arm | 約 $4 | 約 $11 |
| Sonnet 出力（2.5k／5k／10k） | $15／$30／$60 | $27／$55／$110 |
| **Sonnet 合計** | **約 $30〜75** | **約 $49〜132** |
| Haiku（3 反復、全文 arm は高い単価帯） | 約 $9 | 約 $12 |
| Gold の生成と検証（Opus が位置ごとに全文を読む、N 型の後の Scene の読みを含む、再試行 2〜3 倍） | 約 $12〜25 | 同左 |
| judge（Haiku low） | 約 $3 | 約 $4 |
| Sonnet high の照合 | 約 $6〜10 | 約 $10〜20 |
| **合計（人手を除く）** | **約 $60〜120** | **約 $87〜195** |
| 加算（任意）：Opus で A・B のみ（9 の Q13） | 約 $10〜25 | 同左 |
| 加算（任意）：別系列 judge の標本（OpenRouter、Q12） | 数 $ | 同左 |

- count_tokens は費用がほぼ無い。実測で幅を絞る（6.4）。
- **Haiku の小規模な通し（p=30、各作品 10 問）で thinking の出力 token と cache の命中率を実測**し、Sonnet に外挿して 3 水準を更新する。通しは設計を変えるためでなく、費用の実測と bug の確認のため（3.5）。
- 費用の上限（停止線）は事前登録に入る数値。**提案：4 arm は $150、層 2 まで加えるなら $250（見積りの上限の約 1.3 倍）。超えそうなら停止して相談**。9 の Q16 でユーザーが決める。

### 6.3 時間

- 全文 arm は 1 呼出しの prefill が 100k〜310k token で、応答に数十秒〜数分。同時 2 request の制限（0.5）で、C・D（約 200 request）が約 2〜3 時間、小さい arm（約 900 request）が約 1〜1.5 時間 [推測]。Haiku が約 1〜1.5 時間。
- run 全体は実時間で 6〜10 時間の桁（並列度の制限下）。rate limit の実値は [未確認]。

### 6.4 事前の実測（9 の Q15 の許可が要る）

count_tokens は別 endpoint の API 呼出し。対象：6 個の（作品×地点）の全文 prefix、IR 8 event、A の Raw、synopsis。新 tokenizer の影響込みで測り、6.2 の幅と Haiku の 100K 境界をまたぐ位置を確定する。

### 6.5 工程の見積り（実装の手間）

担当は agent の subagent の呼出し回数の目安（実装は Haiku、高リスクは Sonnet、途中のレビューは Opus。subagent-model-policy に従う）。ユーザーの時間は 9 の確認と標本確認だけ。

| 工程 | 規模 | 所要 | subagent の呼出し | ユーザーの時間 |
|---|---|---|---|---|
| 1 確認（0・9） | — | — | 0 | 回答 15〜30 分 |
| 2 事前検査（資源・他 run の有無、複製と gate、golden、policy floor の分布、serializer の cosine、prefix、足場の読み） | 中 | 約 1 日 | 5〜8 | 0 |
| 3 renderer の composition のダンプ（Electron） | 中。足場は v6 の ir-renderer.ts（991 行）と、足場全体 2251 行。再利用できる範囲は工程 2 で読んで見積もる [未確認]。#798 の dump-run は呼出しの型の手本 | 約 1 日 | 5〜8 | 0 |
| 4 ONNX 検索の再現・IR 選択・hit label | 中 | 約 1 日 | 5〜8 | 0 |
| 5 chat body の純関数（build_anthropic_chat_body との一致検証）・IR の描画・prefix の byte 一致 | 小〜中 | 約 1 日 | 5〜8 | 0 |
| 6 Gold の生成・検証・n-gram 検査 | 中 | 約 1 日 | 10〜15（Opus の読みを含む） | 人が書く質問 20 問＋標本確認 30 問程度で 1.5〜2 時間 |
| 7 judge・照合・集計の script | 中 | 約 1 日 | 6〜10 | 0 |
| 8 実行（Haiku の通し→本測定） | 監視 | 実時間 6〜10 時間 | 3〜5 | 0 |
| 9 記録 | 小 | 0.5 日 | 2〜3 | 確認 |
| 合計 | | 約 6〜8 日分の実装 | 約 45〜75 | 約 2〜3 時間 |

## 7 実装

### 7.1 評価専用の harness の置き場所と使い回すもの

- 置き場所：repo の外のデータ置き場と、dev 専用の枝（#798 の診断と同じ扱い。merge しない）。製品のコードは 1 行も変えない。閉じた経路を開けない（`NIR1_LOCAL_GENERATION_UI_ENABLED` は false のまま）。
- **A の正本は renderer の composition**（2.3）。経路の分割：
  1. 実 Electron の renderer から製品の chatContextPreparationComposition.capture／prepare を呼び、system prompt・cacheSegments・volatileTail をダンプする。足場は融合の枠の harness（claude-fusion-ir-eval-v6 の scripts/quality/fusion-slot-eval/）。Electron は DB ごとに 1 回起動して 10 問をまとめて処理する。
  2. IR・全文・synopsis の block は、ダンプした system の tag 位置に、別 process の Node script が文字列として挿入する。
  3. LLM の送信も別 process の Node script。Anthropic Messages API へ直送する。
  4. chat 用の body は、grimodex-ai/src/lib.rs の build_anthropic_chat_body に合わせた純関数を新規に書き、出力が一致することを検証する。#798 の anthropicPayload.ts は chronicle 抽出向け（temperature・thinking なし）なので、そのままは使えない。
- 実 renderer が重い場合の代替（vitest で mock）は records に水準を書く。自前の再実装は prompt のずれを検証できないので避ける。
- 実行環境：Electron は別 userData で、local-ci-xvfb.mjs と Wayland／D-Bus 変数の除去で隔離する（unshare -n で Xvfb を動かさない）。評価の run 中は worktree を触らない。
- aiLiveHarness（OpenRouter 専用）と singleShot.live.test.ts は使わない。
- 検索の再現（B の IR 検索と hit label だけ）：ruri-v3-30m の ONNX を onnxruntime-node と transformers で動かす。golden と一致するまで次へ進まない。

### 7.1.1 再利用する資産・しない資産

| 資産 | 用途 | 再利用 |
|---|---|---|
| v6 の ir-renderer.ts（991 行）と足場 | composition のダンプ、IR の描画の手本 | する（再利用率は工程 2 で見積り） |
| #798 の dump-run（haiku-agg/dump-run.live.test.ts）と anthropicPayload.ts | 呼出しと型の手本 | 型だけ（chat 用の body は新規） |
| 第 6 版の records（records-*-v6.json。query ごとの Raw 位置と probe の IR 順位・cosine） | hit label の検算、golden | する（件数・enum のみ。本文なし） |
| precision-gold の sheet（sheet-user.md、sheet-key.json。ユーザーの strict／partial 注釈） | IR 候補の妥当性の独立な参照、標本確認の κ の見込み | する。本文を含むので repo の外に置き、使うのは件数と一致率だけ |
| related_scenes/scoring.rs と ranking_policy.rs | B の IR 検索の参照実装（golden） | する |
| cargo feature nir1-final-request-eval（DP-H） | packing の候補集合の採取。B_route の形の参照 | B_route（層 3）を採るときだけ |
| scripts/chatRecallLiveEmbed.mjs、relatedScenesLiveEmbed.mjs と relatedScenesLive の eval | 埋め込みの golden fixture、Raw 検索の検算 | する |
| aiLiveHarness、singleShot.live.test.ts | — | しない |

### 7.2 製品のコードを変えないこと

- src/ と electron/ の差分はゼロ。
- Rust の IR 入り prepared request（nir1_prepared_request.rs）は OpenAI-compatible の loopback 専用で Anthropic には使えない。B は DD route の request ではない（2.3）。
- 評価の結果が良くても悪くても、閉じた経路の開閉は別の判断。

### 7.3 保存先

- 本文を含むものはすべて repo の外：/home/grimodex/fusion-eval-data/ir-chat-pilot-2026-11/（0.4。権限 0700）。保存範囲の拡大にあたるかは、判断をユーザーに任せる（9 の Q14）。
- 複製 DB は 3.4 の手順で作る。元の DB は開かない。
- API key は keyring にあり、値は表示・記録しない。送信先は 0.1。

### 7.3.1 ダンプ・ログの扱い

- request のダンプ（system・volatileTail・cacheSegments）には原稿の本文が入る。書込み先は main か Node の評価 process から、repo の外の ir-chat-pilot 配下だけ。権限は 0700（ファイルは 0600）。
- renderer から repo 内へ戻すものは件数と enum に限る。
- 送信ログに Authorization ヘッダなどのヘッダ類を書かない（ログの前に除く）。request 本体のログの場所も上の配下だけ。
- Electron の userData と /tmp の一時物（/tmp/onnxprobe を含む）は、実行後に消す（手順 9 の確認項目）。

### 7.4 records に入れるもの・入れないもの

入れる：

- 件数・長さ（字数）・ID（質問 ID、Scene 番号、event ID）・型・根拠 Scene 数。
- **sha256 は質問集・Gold 集・回答集のファイル全体に 1 つずつだけ**。項目単位の短い Gold の hash は入れない（候補の総当たりで本文を推測できる）。Scene 番号と型の粒度が許容範囲かは 9 の Q14 に含める。
- arm 別の prompt の token、cache の書込み・読み、費用、応答の長さ、stop reason。
- 判定の enum（含む／矛盾／言及なし）、検索の hit、層別の集計表、κ と一致率、棄却数、Gold の誤り率。
- 事前登録の hash と、採用した harness の再現水準。

入れない：

- 原稿の本文・題・抜粋、質問文、Gold の本文、回答の本文、IR の summary と quote、judge の説明文。
- 質問や回答を例として引くこと。
- 項目単位の hash。

## 8 交絡と限界

1. IR の範囲：Chronicle の event だけ。typed Entity／Relation の IR は無い。結論は常に「Chronicle event IR」。
2. 全提案を承認した最大条件：製品の既定の packing より IR に楽観的な側（decision は全件 approved、却下・編集は 0）。製品で作者が編集・却下した IR より誤りが多い側にも少ない側にも偏りうる。結論の読み方は 1.5。
3. 描画の新設：製品に Chronicle event の描画規則は無い。評価専用の形は製品が将来出すものと一致するとは限らない。B は DD route の request ではない（2.3）。
4. B−A の識別：B は A に対して、文脈量・別の検索単位と別の index・quote（Raw の断片）・LLM の要約文を同時に足す。層 2（A′・A″）が無ければ「IR の効果」とは書けない（1.3）。A のゲートで 0 件の質問では、B−A に「ゲートの有無」が混ざる。
5. 位置メタデータ：A の chunk は sceneTitle のみ、C は「Scene N」。B の位置表記は製品の粒度に揃えたが、O 型では序数の手がかりが無い分 IR に不利に出うる。
6. 位置の交絡（C・D）：全文は「長文脈そのもの」と「p より前に限った」の効果を arm だけでは分けられない（Lost in the Middle）。根拠 Scene の位置で層別して記述する。
7. 自己一致：抽出・回答・judge・Gold がすべて Anthropic 系列で、Gold の生成者は g-ja-1 の書き手と同系列。自己選好と自己一致が IR の効果を過大にしうる。別系列は 0.3（承認制）。承認が無ければ限界として残す。Haiku と Sonnet の両方で増分を出し、差を記録する。
8. 記憶・事前知識：m-ja-2 は model が記憶で答えうる。g-ja-1 も AI 原稿で典型的な筋になりやすい。0 arm（層 2）で測る。0 arm が無ければ、m-ja-2 は「記憶と区別できない参考」。
9. 製品の標準より薄い文脈：synopsis・codex・plot thread・chronicle snapshot が空（A_s は synopsis だけを補う）。
10. 検索の seed：質問が短いと検索が Scene p の末尾に引っ張られる（製品の仕様）。製品どおり再現する。B は同じ seed が既定で、B_q は層 3。
11. IR の欠落：g-ja-1 は 10 位置の抽出失敗。IR の被覆は段落の約 41〜45％。IR が答えられない質問が構造的にある。主の層を IR あり層にし、欠けの層は抽出失敗の影響として別に書く（3.1）。再抽出で埋めた版は別の問い。
12. IR は圧縮ではない：g の p=117 で statement の JSON が 150,725 字、根拠 quote が 83,811 字で、前の原稿の約 0.7〜1.1 倍（summary だけなら約 0.32 倍）。top-8 は量を小さく保つが「IR は短い索引」とは言えない。
13. 抽出時の漏れ：event の merge で後の Scene の観測が先の event に混ざっていないか。構造上は起きない [確認済：eventId 884／884 一意、evidenceDocumentRefs は全件 1 Scene] が、評価の前に scope.scene.ref と source.snapshot の対応で再確認する（read-only）。
14. 天井・床：A がほぼ全問不正解、C がほぼ全問正解だと差が測れない。通しで見るが、判定の基準は置かず、見ても設計を変えない（3.5）。
15. judge の限界：Haiku low と人の一致は未測定。arm 別・長さ別に測る（4）。
16. 検出力：5.4。数 pt の増分は検出できない見込み。cluster は 4。
17. prompt の一致：chat の model・effort・max_tokens は利用者の設定で決まり、製品の既定は一意でない。評価では固定する（2.1）。
18. 質問の外的な意味：質問の分布は実際の作者の質問と無関係で、総合値に外的な意味は無い。型別が主（5.1）。
19. 分散：adaptive thinking で temperature を固定できず、回答はばらつく。5.3 の反復で noise floor を測る。
20. token 数は仮定：実測は 6.4。

## 9 ユーザーに決めてもらう問い（推奨と理由つき）

優先度の高いものから。Q1〜Q11 と Q14〜Q16 の回答がそろえば事前登録 v3 を作れる。

- Q1　0.2 の送信内容の表（新規の行 b〜i）を許可するか。行ごとに答える。
  推奨：b（Gold 生成）、c（Gold 検証）、d・e（回答）、g（採点）、i（count_tokens は Q15 で別に聞く）を許可。f（synopsis の生成）は Q3 で A_s を採るときだけ。h は Q13、j は Q12。cache の一時保持（最大 5 分）を含む。
- Q2　この pilot 用の Gold を新設してよいか（作り手は Opus 5.5 の生成と Sonnet 5.5 の検証。既存の Gold や台帳には触れず、not-cp4-evidence として分離）。
  推奨：許可。無ければ手順 4 に進めない。
- Q3　arm を 4 つから拡張するか（層 2：0、A_s、A′、A″）。
  推奨：4 つすべて加える（費用は $60〜120 から $87〜195 へ）。「IR の効果」と書くには A′・A″、基準線の妥当性には A_s、記憶と推測しやすさの分離には 0 が要る。最小なら 0 と A_s。4 arm のままなら、結論は 1.3 の言い方に限定する。
- Q4　層 3（B_route、B_q、B2、B_ord）を加えるか。
  推奨：今回は加えない。B_q と B_free は LLM なしの label だけ計算する。B_route は route の packing の効果を測る別の問いで、結果次第で次の pilot。
- Q5　IR の描画（2.4）：quote 付き 1 種類、位置は Scene タイトルのみ（製品の related_scenes の粒度）、並びは score 順。
  推奨：この形。描画の文言は評価専用の新設なので、確定前にこの確認を取る。
- Q6　現在 Scene（Scene p の本文）を全 arm に入れるか。seed は質問本体＋末尾 500 字か。
  推奨：入れる。seed は A と同じ。Scene p だけで答えられる質問は label にして除外しない。
- Q7　B の IR 選択を製品の compiled policy（floor 0.813、Scene dedup、最大 8 Scene）にするか。
  推奨：する（閾値を新設しない）。top-8 無閾値は label のみ。floor を通る event が少なすぎても floor は変えず、0 件として記録する。
- Q8　規模と位置：主の位置を 59・117、各 cell に LLM 生成 20 問＋人 5 問（計 100 問）、p=30 は Haiku の通し専用の別集合。
  推奨：この形。通しの結果では設計を変えない（3.5）。規模を増やすなら別の事前登録でユーザーが決める。
- Q9　主の層を「根拠 Scene に IR がある層」、全質問を同格で併記、でよいか。
  推奨：よい。抽出失敗は方式の性質でないため。欠けの層は別に書く。
- Q10　Gold の標本確認（30 問程度）と、人が書く質問（各作品 10 問）の時間を取れるか。
  推奨：両方とも必須として取る（合計 1.5〜2 時間）。取れなければ、結論に「Gold 未確認」「人が書く質問なし」を明記して限定する。
- Q11　結果を製品判断の入力に使わず（探索）、1.5 の「結果パターン→判断」の表を「次の設計の優先順位」として採るか。
  推奨：製品判断に使わない。表は採る（数値の閾値なし）。判断に使うなら v3 で固め直す。
- Q12　別系列 model（OpenRouter、gpt-6-luna）を、Gold の検証と judge の標本だけに使うか（用途拡大。原稿は送らない）。
  推奨：使わない（評価の API は Anthropic 優先）。使わない場合は限界（8-7）に残す。使うなら、judge の区切りの 1 回だけ。
- Q13　自己一致の確認として、A・B のみ Opus 5.5 で回答させるか（行 h。Opus への送信の追加）。
  推奨：区切りの 1 回だけ、A・B のみ。C・D は費用が約 2 倍なので、必要になってから。
- Q14　保存先（/home/grimodex/fusion-eval-data/ir-chat-pilot-2026-11/）と保存の量・期間・削除（0.4）が、保存範囲の拡大にあたるか。records に入れる Scene 番号と型の粒度、全体 hash 1 個の方針を許容するか。
  推奨：既存の置き場の下なので拡大にあたらないと考えるが、判断はユーザー。完了後 30 日で全文ダンプと複製 DB を削除。
- Q15　count_tokens の API 呼出し（別 endpoint）を許可するか。
  推奨：許可（費用はほぼ無く、6.2 の幅を確定できる）。
- Q16　費用の上限と停止の動作。同値・非劣性の幅は置かないことの確認。
  推奨：停止線は 4 arm で $150、層 2 まで加えるなら $250。超えそうなら停止して相談。同値の幅は置かない。
- Q17　API の干渉：専用の key か時間帯の分離、並列度（全文 arm は同時 2、小さい arm は同時 8）。他の run が走っていないことを確かめてから開始する方針。
  推奨：専用の key が無ければ、他の run が無い時間帯に実行。429 が続いたら停止。
- Q18　D′（全 IR を年表として全文の前に付ける）と、g-ja-1 の欠け 10 Scene を再抽出して埋めた版を加えるか。
  推奨：どちらも今回は加えない（別の問い。再抽出は費用と手順の判断が要る）。

## 10 CP-4 などとの順序

- 設計と 9 の確認は read-only で、他の lane を止めない。
- CP-4 の正式 run や他の評価 run が走っている間は、評価の worktree と profile に触れない。実行は走行がないことを確認してから。API は key・org の rate limit・費用を他の run と共有するので、走行の有無（プロセスと API 呼出し）を開始前に確かめ、並列度と token／分の上限を事前に決める（0.5）。
- lane の順（DR-IRB-3 → IR query 高速化 → #798 → PUB-G の前提）には割り込まない。ただし #798 の dump-run の足場を手本にするので、その枝が動くまでは手本の読み取りだけ。
- 着手の順（**NIR-1 の事前委任は適用外**）：
  1. **0 の precheck の確認と 9 の回答**（`[precheck]` で停止。この確認が済むまで他へ進まない）。
  2. read-only の事前検査と資源の preflight：他の run の有無、CPU・メモリ・ディスク、複製と 3.4 の gate、golden（composition と自前の再現の一致、v6 の records との照合）、policy floor を通る event 数の分布、serializer の cosine、prefix の実態、足場の再利用率の見積り、count_tokens（Q15 の後）。
  3. 事前登録 v3 の確定（arm・位置・描画・IR の選び方・型の配分・0 arm の規則・判定・Gold の手順・費用の上限・結果の読み方・何を結論にしないか。hash 固定）。
  4. Gold の生成と検証、標本確認（**Q2 の回答の後だけ**）。
  5. Haiku の通し（p=30 の別集合。探索。変えてよいのは bug と採点規則の明確化だけ。費用と cache の実測）。
  6. 本測定（Haiku は 3 反復、Sonnet は全 arm 1 回に A・B・A_s の 2 回目）。通しの結果で arm・質問・配分・主指標を変えない。
  7. 区切りの Sonnet high の照合と人の抜き取り。
  8. 記録（records に本文を入れない。userData と /tmp の一時物を消す）。
- 3 の確定までは API を呼ばない（Q15 の許可後の count_tokens を除く）。

## 採らなかった指摘（一部採用・条件つきを含む）

- 指摘 1（A′・A″ を必須 arm に）：必須とはせず、層 2 の推奨としてユーザー確認へ回した。arm を 4 つとしたユーザー決定を黙って変えないため。4 arm のままなら、結論の言い方を限定した（1.3）。
- 指摘 3（A の chunk にも Scene 序数を付けた対照）：採らない。製品の挙動から離れる。代わりに IR の位置表記を製品の related_scenes の粒度（タイトルのみ）に落とし、序数つきを B_ord（層 3）にした。event の並びは、序数の手がかりにならないよう score 順に変えた。
- 指摘 19（主の比較を B 対 A_s に）：A_s の承認が条件。承認が無ければ B−A を主にして、1.3 に「story_so_far なしの下限に対する増分」と明記する。
- 指摘 20（B_route を追加）：層 3 の任意にとどめた。route の packing の効果は別の問い。1.3・2.3 に「B は上乗せで route の request ではない」と明記した。
- 指摘 22（B_q を arm 化）：層 3 と label にとどめた。既定の seed は A と同じ。
- 指摘 34（backup API か VACUUM INTO で複製）：採らない。元の DB を開くので lock や checkpoint で元の run に干渉しうる。代わりに完了確認＋-wal／-shm つきの file copy＋前後の sha256 で元が変化しないことを確認する（指摘の「元は 1 度も開かない」と整合する）。
- 指摘 13・27（OpenRouter の別系列）：検討の入口は開けたが、推奨にはせず、承認制の Q12 にした。「回答を IR だけの arm で別系列に」は採らない（IR は原稿由来の内容で、送信の用途拡大が大きい）。標本の judge・Gold 検証だけを選択肢にした。
- 指摘 11（非劣性の幅）：置かない。幅の新設は閾値の新設で委任の外。H1 は区間つきの推定に書き換えた。
- 指摘 21（結果→判断の表）：採用したが、指摘 37 と整合させ、製品判断でなく「次の設計の優先順位」に限った。
- 指摘 25（Haiku の通しで費用を実測して外挿）：採用したが、通しは p=30 の別集合で、設計は変えない（指摘 9 と整合）。
- 指摘 12（主を IR あり層に）：採用。ただし主の層の選び方は選別でなく事前固定の label による層別で、9 の Q9 で確認する。
