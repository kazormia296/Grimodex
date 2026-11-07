# 実製品の chat で IR は質問に効くか — pilot の設計と事前登録の下書き（v3）

状態：下書き v3。ユーザー決定 4 件（2026-11-07）と integrator の既定を反映。API は 1 回も呼んでいない。**送信の確認（0 節）は決定 1 で済み**。残るのは、実行の前に頼む Gold の約 30 問の照合だけ（11.2）。事前登録の確定（hash 固定）は、その照合と Haiku の通しの後（7 節）。
日付：2026-11-07。基点：origin/master 73c48507（製品コードは v2 で git show により read-only で確認した範囲を引き継ぐ）。
表記：[確認済]＝DB・コード・先行事例の照合で確認、[推測]＝計算または仮定、[未確認]＝まだ見ていない。
規則：原稿の本文・質問文・Gold・回答・IR の statement と quote は repo に入れない（8 節）。この文書も本文を含まない。

## 改訂の履歴

- v3.1（2026-11-07）：人の照合を「抜粋だけで 30 問、N を除く、約 30 分」にした（ユーザーの決定。原稿を通して読まない）。

- v1：初版。v2：レビュー 38 件を反映（precheck の新設、arm の 3 層化、18 の問い）。
- v3（2026-11-07）：v2 の 614 行を絞り直した。
  - 決定 4 件を反映：送信と judge は Anthropic のみ／Gold は AI 下書き＋人の抜き取り／arm は 6 つ（0 と O を追加）／規模は 80 問・上限 $50。
  - v2 の 18 の問いを閉じた（11.1）。残る依頼は Gold の約 30 問の照合だけ。
  - 先行事例調査の §7 を設計に入れた（9 節）：根拠位置の必須化、答えられない質問と棄権・作話の分離、項目の再現率と誤りの混入の分離、judge の誤受理率の測定、全 arm 共通の prompt、token と並べ順の記録。
  - 削除：層 2・3 の arm（A_s、A′、A″、B_route、B_q、B2、B_ord）、OpenRouter、Opus の回答、結果→判断の表、p=30 を含む 100 問の設計、v2 の 6〜8 の費用表。

## 0 precheck（GDX-PRECHECK-001）

外部送信、長時間実行、prompt cache、Electron の subprocess を含むので、NIR-1 の事前委任の外で扱う。

### 0.1 ユーザー決定の記録（2026-11-07、AskUserQuestion で 1 回。選んだ選択肢の逐語の要旨）

1. 送信と judge：**「Anthropic だけ」**。原稿の全文・IR・質問・回答・judge の入力は、すべて Anthropic の API にだけ送る（抽出のときと同じ送信先）。judge も Anthropic の model。人が確かめた Gold の項目との照合に限り、人の抜き取りで較正する。自己選好の恐れは限界として書く。OpenRouter は使わない。
2. Gold：**「AI が下書き・一部を人が確認」**。AI が位置 p より前の原稿から、IR と独立に、質問・事実の項目・根拠の位置を作る。ユーザーが約 30 問を照合する（約 1 時間）。誤り率を結果に併記する。
3. arm：**「本文なし＋根拠だけ」を足して 6 arm**。(0) 質問だけ、(A) 製品相当の Raw、(B) A＋出来事の IR、(C) 位置より前の全文、(D) C＋出来事の IR、(O) Gold の根拠の段落だけ。
4. 規模：**「80 問・上限 $50」**。2 作品（g-ja-1 が主、m-ja-2 は参考）×2 地点×20 問。回答は Sonnet 5.5 high を 1 回、反復の確認は Haiku 5.5 low。

決定 1 により、v2 の送信の個別確認（旧 Q1、Q12、Q13、行 h・j）は済み。

### 0.2 actor・送信先・保持・停止点

| 項目 | 内容 |
|---|---|
| actor | 評価 harness（別 process の Node script）、Electron の renderer と main（arm A の文脈のダンプだけ）。評価用の keyring の Anthropic key（値は表示・記録しない） |
| 送信先 | Anthropic の Messages API と、同じ API の count_tokens だけ。ほかは無し |
| 送るもの | 位置 p までの原稿（作品ごと。Gold の N 型だけは p より後も）、IR、質問、Gold、回答（gen／回答／judge 用）。key・profile・他プロジェクトのデータは送らない |
| 送信内容×model | Gold の下書きと検証：Sonnet 5.5 high。回答：Sonnet 5.5 high（本測定 1 回）、Haiku 5.5 low（通し・反復）。judge：Haiku 5.5 low、一部 Sonnet 5.5 high。Opus は使わない |
| 保持 | Anthropic 側の prompt cache（ephemeral、5 分 TTL。1 時間 cache は使わない）。repo の外の保存（8 節）。repo には件数・enum・全体 hash だけ |
| 停止点 | 他の run との重なりの疑い、429 の連続、費用の停止線（6.4）、複製 DB の漏れ検査の不一致、golden の不一致、cache が効かない（6.4）。Gold 照合の前は事前登録に進まない |

## 1 目的と、言えること・言えないこと

### 1.1 目的

ユーザーの関心は「実製品の chat で、質問に対して IR は有効か」。ここでの IR は、第 6 版で build した Chronicle の event 提案（NIR-1 の Narrative IR）。今の製品の chat に IR は入っておらず、IR を request に入れる経路は閉じている（`NIR1_LOCAL_GENERATION_UI_ENABLED=false`）。評価専用の経路で、同じ質問に対して IR を足した chat と足さない chat を比べる。製品コードは変えない（7.2）。

### 1.2 結果の扱い（integrator の既定）

- 探索の pilot。**目的は、次の正式な試験の規模と質問の型の配分を決める材料を得ること**。not-cp4-evidence、PUB-G の証拠ではない。製品判断（閉じた経路の開閉、鮮度、枠の大きさ、PUB-G）には使わない。
- **閾値・採否の規則は置かない**。出すのは、対応のある差の推定と区間（cluster は作品×地点）だけ。「差なし」も有効な結果として記録する。
- 実行は CP-4 の正式 run と重ねない（arm A は製品の検索を実際の renderer で動かすため）。

### 1.3 言えること

- 「g-ja-1 と m-ja-2 の 2 作品、各 2 地点（59・117）で、**出来事の IR の block を足した効果（文脈の量・検索単位の違い・quote の追加を含む）**の推定値と区間」。結論に「IR の効果」とは書かない（量・検索・要約の分離をしていないため。10 節）。
- 質問の型別・根拠 Scene の IR の有無別の差の記述（副）。棄権と作話の別集計。IR 由来の誤りの混入の観察。
- 正式な試験の規模の見積り：観測した不一致率と cluster の相関から、必要な質問数と作品数を計算する。

### 1.4 言えないこと

- 「IR 一般」の効果。第 6 版の DB の IR は **Chronicle の出来事だけ** [確認済：g-ja-1 は proposal 884 件、すべて `chronicle.create-event@1`・承認済み、Codex の項目と関係は 0 件。integrator が DB の写しで確認]。製品の packing の accepted-ir（Codex の Entity の型つきの改訂）は**測れない**。製品の route の request でもない（B は A への上乗せ。2.3）。
- 窓の小さい local model での圧縮効果、agent の tool を使うモード、製品の実利用（synopsis・codex・chronicle snapshot が入った文脈。評価 DB では空）、鮮度や枠の大きさの効果、作品をまたぐ一般化。
- 事実 QA は執筆支援の proxy にとどまる。

## 2 arm

### 2.1 共通の固定

[確認済・v2 から引継ぎ] 製品の chat は chatContextPreparationComposition.capture／prepare → prepareTurn → planChatContext → buildSystemPrompt の順で request を作る（mode="chat"、tool なし）。**全 arm で同じ**にするもの：

- system の土台（chatSystemBase、DataBoundaryReminder、tag 構造）は製品の buildSystemPrompt の出力を使う。自前の再実装はしない。
- **同じ reader・同じ prompt**：user message は質問本体と、別の 1 文の定型句（「ここまでの原稿の範囲で答えてください。原稿から分からないことは分からないと答えてください」の趣旨）だけ。history なしの単発。定型句は棄権・作話を測るために必要で、製品の prompt に無い（棄権が強まりうる。10 節）。検索の seed は定型句を除いた質問本体で作る。
- 現在の Scene（Scene p の本文）を current_scene として**全 arm に入れる**（製品と同じ）。
- answer model・effort・max_tokens は事前登録で固定。Sonnet 5.5 は effort high、Haiku 5.5 は effort low、thinking は adaptive。**temperature 等の sampling 引数は送らない**。max_tokens は 6,000（thinking を含む。Haiku の通しで切れ率を見て、凍結前に 8,000 に上げるかを決める）。
- 各 request について**入力 token（usage）、断片の並べ順、cache の書込み・読み、stop reason を記録**する。

### 2.2 arm 一覧

| arm | 内容 | 目的 |
|---|---|---|
| 0 | 質問だけ（system＋project_info＋current_scene。related_scenes・IR・全文なし） | 記憶・推測しやすさの床 |
| A | 製品相当の Raw（related_scenes） | 基準線（story_so_far なしの下限） |
| B | A＋出来事の IR block | 主の対象 |
| C | Scene < p の全文 | 上限の目安 |
| D | C＋IR | 注意誘導・妨害の効果 |
| O | Gold の根拠の段落だけ（Scene < p の原文） | oracle。検索の失敗と読解の失敗を分ける |

- N 型（答えられない質問）の O は根拠の段落が無いので、0 と同じ入力になる。
- 位置 p ごとの複製 DB（Scene ≤ p。3.4）から全 arm の入力を作る。

### 2.3 arm A と arm B

arm A：project_info、current_scene、related_scenes。story_so_far・codex・chronicle_snapshot は評価 DB で空。related_scenes は製品の semanticRecall.ts の規則どおり [確認済・v2]：seed＝質問本体＋現在 Scene 末尾 500 字、hybrid（dense 30＋FTS5 sparse 上位 10 の RRF、RRF_K=60）、日本語は top-1 が 0.85 に届いたときだけ 0.80 まで拾う、最大 3 chunk・1 chunk 600 字、ゲートを通らなければ 0 件（製品と同じ挙動として記録）。見出しは「### 抜粋: <sceneTitle>」で Scene の序数は付かない。**A の正本は renderer の composition**（実 renderer で製品の関数を動かして system をダンプ）。自前の ONNX 検索は B の IR 検索と hit label だけに使い、composition の chunk 集合との一致（golden）を取ってから進む。

arm B：A の request に IR の block を `<codex_entries>` の位置に追加する。**B は A への上乗せで、DD route の request ではない**。

- **IR の選び方は製品の policy**（policies/narrative/nir1-related-scenes-ranking.json）[確認済・v2]：ja の cosine floor 0.813、Scene で重複除去（1 Scene につき最高スコアの event 1 つ）、最大 8 Scene。Scene < p の event だけから選ぶ。floor を通る event が 0 件なら IR 0 件として記録（floor は変えない）。
- 検索 query は A と同じ seed。query 側の prefix は製品の IR 検索（related_scenes/scoring.rs）と揃え、手順 2 で LLM なしに確かめる [未確認]。serializer（chronicle-semantic-retrieval/1）と ordered-json/1 の同一性、vector が無い event（m-ja-2 の Scene 99 の 8 event）の再埋め込みも手順 2 で確かめる。
- 位置 p ごとに IR の index を作り直さない。event は Scene をまたがない [確認済・v2：1 Scene 1 run、eventId 884／884 一意]ので、Scene < p で切れば位置 p の時点の集合と同じ。

### 2.4 IR の描画（評価専用・1 種類）

製品に Chronicle event を chat に出す描画は存在しない [確認済・v2]。評価専用に **quote 付きの 1 種類**とする。

- 1 event を数行：位置（Scene のタイトルのみ。序数・段落番号なし。製品の related_scenes と同じ粒度）、summary（約 75 字）、actuality／attribution／narrativeFrame、人物の表層・場所・時間表現（ある場合）、根拠の quote（evidenceSet 全件）。
- 並びは score 順（Scene の昇順にすると序数の手がかりを与えるため）。量は 8 event で約 1〜2.6K 字 [推測]。
- 描画の文言は評価専用で、製品の UI 文言や契約ではない。

### 2.5 arm C・D・O

- **C**：Scene 1〜p−1 の全文を、story_so_far の位置（current_scene の前）に 1 つの block として入れる。見出しは「Scene N」の素の番号だけ。related_scenes は入れない。大きさ [確認済・原稿の字数]：g-ja-1 は p=59／117 で 101,130／208,344 字、m-ja-2 は 106,929／199,205 字。1 prompt は約 130k〜260k token（6.1 の仮定）、窓 1M 以内。
- **D**：C の request に B と同じ手順・描画の IR block を、原稿の後ろ・質問の前に追加する。C と D は current_scene までの prefix を byte 一致にする。B−A は「情報の補給」、D−C は「注意誘導と妨害」で、別の量として読む。
- **O**：Gold の各項目の根拠（Scene 番号＋原文の抜粋を含む段落）を原文のまま渡す。要約・構造・IR は無し。

## 3 質問と Gold

Gold の新設は決定 2 で承認済み。この pilot の Gold は not-cp4-evidence として分離し、既存の Gold・台帳には触れない。

### 3.1 規模と位置

- 2 作品（g-ja-1 が主、m-ja-2 は参考）×2 地点（p＝59 と 117）×20 問＝80 問。1 問は 2〜3 個の検証できる事実の項目に分ける（約 200 項目）。
- g-ja-1 は AI が書いた原稿で model の学習の締切の後なので、記憶の交絡が小さい。m-ja-2 は公有の古典と見え、model が記憶で答えうる（0 arm で測る）。主の指標は両作品を合わせ、作品別は記述する。
- p=30 の別の小さい質問集（各作品 6 問）を **Haiku の通し専用**に作る（Gold の人の確認は無し）。本測定の質問とは重ならない。
- g-ja-1 の IR の欠け [確認済・v2]：抽出の失敗 10 位置と event 0 件の Scene 36 の計 11 Scene は IR 0 件。p=59 で 1／58、p=117 で 11／116。m-ja-2 は event 0 件の Scene が 5（10、13、14、72、91）。欠けは今回の run の技術的な失敗で、方式の性質ではないので、根拠 Scene に IR がある層は副として別に出す。

### 3.2 質問の型と配分

型は LongMemEval（複数箇所・時間・更新・棄権）と NovelQA の側面（人物関係・細部）に寄せる（9 節。NovelQA は照合が「本」のみなので型の寄せは設計判断で、根拠としては LongMemEval と DetectiveQA を引く）。1 cell あたり 20 問：

| 型 | 内容 | 件数 |
|---|---|---|
| E | 単一箇所の細部（出来事の有無・当事者・場所） | 4 |
| M | 複数 Scene にまたがる集約（根拠 Scene 3 以上） | 4 |
| T | 出来事の順・時間 | 3 |
| U | 状態の更新（後で変わった事実。p 時点の状態） | 2 |
| R | 人物関係 | 2 |
| K | 誰が何を知っているか／まだ知らないか | 2 |
| N | **答えられない質問**（棄権が正答） | 3 |

- **N の作り方**：p=59 は Scene > 59 にだけある事実を 2 問、原稿に書かれていない詳細（または前提が誤り）を 1 問。p=117 は最後の Scene なので後の事実が無く、書かれていない詳細・前提の誤りの 3 問。作品ごとの N の「後の Scene を使う」割合は records に出す。
- 答えのある 17 問の根拠 Scene は、前方・中盤・直近（p−5 以内）に割り当てを固定し、生成の prompt に与える（目立つ場面や直近への偏りを避ける）。
- 型の配分は事前登録で固定する。全体で答えのある問いは 68 問。

### 3.3 作り方と検証

- **生成**（Sonnet 5.5 high。IR を入力に使わない）：Scene 1〜p−1 の本文だけを渡し（N の後の Scene の事実だけ全文を渡す）、型・根拠の層を指定して、質問・事実の項目・**根拠の位置（Scene 番号＋原文の逐語の抜粋）**を出させる。質問は原文の語句を写さず、作者が chat で聞く自然な言い方（口語・言い換え）にする。
- **機械検査（すべて通す）**：根拠の抜粋が原稿の該当 Scene に逐語で存在する。根拠の Scene 番号がすべて p 未満（N の後ろの事実を除く）。質問に p 以降にしか出ない固有名が無い。質問と原文の n-gram の重なりが基準以下（基準は凍結時に固定。FTS5 と dense の検索を当たりやすくする転記を除く）。
- **別呼出しでの検証**：O と同じ入力（根拠の段落だけ）で Sonnet 5.5 high が答え、Gold と食い違う問いを棄却または直す。N は、Scene < p の全文を渡した Sonnet が「分からない」と答えることを確かめる。型別の棄却数を records に出す。
- **人の確認（実行の前。11.2）**：答えのある型（N を除く）から型・作品・地点で層別した 30 問を、ユーザーが sheet で照合する。**原稿は通して読まない**（ユーザーの決定 2026-11-07「抜粋だけで 30 問」）。sheet には問いごとに、質問、事実の項目、根拠の逐語の抜粋とその前後の数段落だけを載せる。判定は 2 点：抜粋が項目を支えているか、質問が曖昧でないか（1 問 1 分前後、計約 30 分）。N は全文の知識が要るので人の照合から外し、機械の検査と全文を渡した Sonnet の検証だけにして、結果に「N の Gold は人が確かめていない」と書く。**誤り率（直し・棄却の割合）を Wilson 区間つきで結果に併記**する。確認しなかった約 50 問は未確認として扱い、主指標は全 80 問と確認済みの 30 問の両方で出す。
- g-ja-1 の outline.md は書き手の意図で、本文と食い違う軽微な矛盾が約 25 件ある [確認済・v2]。候補の出所にとどめ、本文で検証した項目だけを Gold にする。AI が生成者かつ g-ja-1 の書き手と同系列である点は限界（10 節）。

### 3.4 DB の切り方と漏れの検査

複製の手順（元の run の DB は開かない）：

1. 元 DB（runs-ir の下）が完了済みで書き手がいないことを確かめる（run の process が無い、-wal が空か無い、更新時刻が変化しない）。
2. -wal／-shm を含めて file copy し、前後の sha256 で元の不変を確かめる。複製側で integrity_check、件数を元の記録と照合。
3. 複製側で Scene > p を切る：tree_nodes、scene_chunks とその embedding、FTS5（rebuild）、IR の proposal・vector・observation、そのほか Scene 番号を持つ表（一覧は schema から作る）。dense の pool と sparse の上位は切った集合で作る。作品 2×地点 3（59・117・通し用の 30）＝6 個。
4. **harness の gate（1 つでも不一致なら止める）**：p より後の scene ID が全表・全 index で 0 件。project_info・章・Scene のタイトル・plot thread に後の内容が無い。chunk の neighbors が p より後を指さない。
5. **request の漏れ検査**：ダンプした全 request で、Scene > p の本文の 20 字の shingle が 0 件ヒット（N の質問の生成 prompt は除く）。

### 3.5 label（結果の前に機械で付ける。選別でなく層別）

根拠 Scene に IR の event があるか／検索の hit（A の chunk に Gold の根拠段落が入ったか、B の選択の根拠 Scene が Gold を含むか）／Scene p だけで答えられるか（Scene p だけを渡した Haiku）／根拠 Scene の数（1／2〜3／4 以上）と位置／推測可（0 arm で Haiku・Sonnet のどちらかが答えた項目）。IR の有無や hit で質問を選別しない。

## 4 採点

- **項目の再現率と誤りの混入を別の判定にする**（9 節）。(a) 再現率：Gold の項目ごとに、回答がそれを含む／含まない（言及なし）。partial は作らない二値。(b) 誤りの混入：回答に、Gold の項目または根拠の段落と矛盾する、または原稿に無い主張（作話）が含まれるか。ヘッジの列挙（複数候補を並べて Gold を含ませる）は (b) で矛盾とし、(a) の「含む」にしない。
- **N 型**：「分からない」と述べれば棄権（正）、具体的な答えを述べれば作話。答えのある質問での棄権（過剰棄権）と N での作話を別に数える。N は arm 間の正答率の比較に入れない。
- 3 段：(1) 固有名・数は機械で逐語照合、(2) 言い換え・含意は Haiku 5.5 low の judge（入力は質問・Gold の項目・根拠の段落・回答だけ。**参照は人が検証した原稿由来のものを必ず与える**）、(3) Sonnet 5.5 high が、judge の出力の無作為 25％と、(b) の陽性・N 型の全件を照合する。
- **盲検**：採点の前に回答から位置表記（Scene・段落の言及）と IR 特有の書式を除く。judge には arm 名を渡さない。
- **judge の誤受理率の測定**：Gold から、曖昧な誤答を作る（20 問ずつ：具体的だが誤った答え、Gold を候補に含むヘッジの列挙、一般的で空疎な答え。Sonnet が作る）。同じ judge に通し、誤って「含む」とした割合を Wilson 区間つきで出す（9 節、S12）。
- **人の抜き取りでの較正**（実行の後。11.3）：arm・回答の長さで層別した約 40 項目をユーザーが判定し、judge との一致率・κ・**差の向き**（judge が寛容か厳密か。arm ごと）を出す。取れなければ結論を「judge 未較正」に限定する。
- 自己選好：抽出・IR・回答・Gold・judge がすべて Anthropic 系列で、自己選好が一方向に効きうる。先行の裏づけは照合が弱い（抜粋のみ）ので推測の限界として書く。Haiku と Sonnet の両方の差を出す。

## 5 指標と分析

- 質問の点数＝その質問の Gold の項目のうち「含む」の割合。
- **主指標（1 つ）**：Sonnet 5.5 の回答で、両作品を合わせた **B−A の項目の正答率の差**（答えのある 68 問。質問単位の対応のある差の平均）。
- **副（記述。検定しない）**：根拠 Scene に IR がある層での B−A、型別（E・M・T／U・R・K）、作品別（g-ja-1 を先に）、地点別、D−C、C−A、O−0、O−A、B−0。推測可を除いた版。(b) 誤りの混入率、過剰棄権率と N の作話率（arm 別）、検索の hit 別の正答、arm 間の不一致セルの件数、Haiku の揺れ。
- **区間**：質問を単位に cell で層別した bootstrap（1 万回）の 95％区間。cluster（作品×地点＝4）は、1 cluster を除いた推定値 4 個の範囲を併記する（cluster bootstrap は 4 では不安定）。p 値と採否の閾値は出さない。
- **Haiku の反復**：0・A・B・O は全質問を 3 回、C・D は 1 回。同じ arm・同じ項目の判定が割れる割合を揺れの目安とする。Haiku の数値は Sonnet に持ち越さない（Sonnet は 1 回のため、揺れを直接は測れない。限界）。
- **検出力 [推測]**：答えのある 68 問、不一致率 0.2 で、検出できる最小差は約 15 pt、cluster の相関で実効 n が減るとさらに大きい。先行の増分は数 pp（9 節 A13、A7）で、**この pilot で有意差は出ない見込み**。成果は、差の推定と区間、型・label 別の観察、正式な試験に必要な質問数と作品数の見積り。

## 6 費用の再見積り（上限 $50）

### 6.1 前提 [確認済は価格のみ。ほかは推測]

- 価格（100 万 token あたり、入力／出力）：Sonnet 5.5 は $2／$10、Haiku 5.5 は $0.10／$0.50（100K 超の帯が高い可能性。下の上限では全文 arm を 5 倍で計算）。cache の書込み 1.25×、読み 0.1×。
- **日本語の token 数**：位置まで前の原稿は 4 cell の合計で 615,608 字 [確認済・字数]。**1.25 token／字（幅 1.0〜1.5）**で約 770k token（616k〜923k）[推測]。根拠は v2 の仮定（日本語は 1〜1.5 token／字、新 tokenizer は旧比で約 3 割増の見込み）で、実測はしていない。最初に count_tokens（同じ送信先、費用ほぼ 0）で 6 個の prefix を測って上書きする。幅の ±20％は C・D の入力で約 ±$2 に収まる。
- **全文 arm（C・D）は (作品, 地点, arm) ごとに cache を書き**（1.25×）、20 問を 5 分以内に続けて読む（0.1×。読むたびに TTL が延びる）。初回の応答を待ってから残りを送る（同時 2 request まで）。1 (cell, arm) の入力費＝prefix×$2/M×(1.25＋19×0.1)＝prefix×3.15 倍。C と D は prefix が byte 一致なので D は C の cache を読めるが、費用は別々に書込みを数えて保守的に見積る。
- 小さい arm の 1 問あたり入力：0 が約 5k、A が約 8k、B が約 11k、O が約 7k token。80 問で約 2.5M token。
- Sonnet 5.5 high の 1 request あたりの出力（thinking を含む）：**2k／3.5k／6k token の 3 水準**。480 request（80 問×6 arm）。

### 6.2 内訳

| 項目 | 下（2k） | 中（3.5k） | 上（6k、全件が上限） |
|---|---|---|---|
| Sonnet 入力：C・D（cache あり。prefix 616k／770k／923k token） | $7.8 | $9.7 | $11.6 |
| Sonnet 入力：小さい arm と C・D の後ろの部分 | $5.5 | $5.5 | $5.5 |
| Sonnet 出力（480 request） | $9.6 | $16.8 | $28.8 |
| Gold の下書きと検証（Sonnet 5.5 high。全文を読む呼出しは cache、再試行込み） | $4 | $6 | $9 |
| Haiku：通し（p=30、72 request）と反復（小さい arm 3 回、C・D 1 回。全文 arm は高い帯の最悪で 5 倍） | $2 | $3.5 | $5 |
| judge（Haiku 全件）、Sonnet high の照合、誤受理率の測定用の回答生成 | $2 | $3.5 | $5 |
| **合計** | **約 $31** | **約 $45** | **約 $65** |

- cache が効かない場合（C・D の入力が 20 倍）は約 $62〜74 の追加になるので、効かなければ止める（6.4）。
- 中央の見積り（約 $45）は上限の $50 に収まる。**上の水準（出力が 6k に張り付く）は $50 を超える**。Haiku の通しで出力 token の実測値を取り、凍結の前に再見積りする。

### 6.3 凍結前の縮小の規則

Haiku の通しの実績から外挿した中央値が **$42 を超える**場合は、凍結の前に、各 cell を 20 問から 16 問（N は 2 問、答えのある問いは 14 問）に縮める。それでも超えるなら止めて相談する。凍結の後は規模を変えない。

### 6.4 止める規則

- 費用は全 request の usage から累積で計算し、1 cell が終わるごとに残りを外挿する。
- **実行の順（主指標を先に）**：0・A・B・O（全 cell、約 $16）→ C・D を cell の小さい順（g59、m59、g117、m117）。
- 累積が $40 に達したときに残りの外挿が $50 を超えるなら、残りの C・D の cell を止めて相談する（B−A の主指標は先に終わっている）。**累積が $50 に達したら即時停止**。上限の変更はユーザーの決定。
- 全文 arm の最初の 2 request の後、cache_read_input_tokens が prefix の 9 割未満なら止める。429 が 2 回続いたら並列度を半減し、さらに続けば停止。max_tokens に達した切れが全体の 2％を超えたら止める。

## 7 実装の手順と時間

harness は repo の外のデータ置き場と、**dev 専用の枝（#798 の診断と同じ扱い。merge しない）**に置く。製品のコードは 1 行も変えない。

### 7.1 使い回すもの

| 資産 | 用途 |
|---|---|
| v6 の ir-renderer.ts（991 行）と足場（claude-fusion-ir-eval-v6 の scripts/quality/fusion-slot-eval/） | composition のダンプ、IR の描画の手本 [再利用率は手順 2 で読んで見積る。未確認] |
| #798 の dump-run と anthropicPayload.ts | 呼出しの型の手本（chat 用の body は純関数を新規に書く） |
| 第 6 版の records（Raw 位置と probe の IR 順位・cosine。件数と enum のみ） | hit label の検算、golden |
| related_scenes/scoring.rs と ranking_policy.rs | IR 検索の参照実装（golden） |
| scripts/chatRecallLiveEmbed.mjs、relatedScenesLiveEmbed.mjs | 埋め込みの fixture、Raw 検索の検算 |
| precision-gold の sheet 形式 | 照合 sheet の様式 |

aiLiveHarness（OpenRouter 専用）と singleShot.live.test.ts は使わない。Electron は別 userData で、local-ci-xvfb.mjs と Wayland／D-Bus 変数の除去で隔離する（unshare -n で Xvfb を動かさない）。評価の run 中は worktree を触らない。

### 7.2 手順と見積り

| 手順 | 内容 | 作業日 |
|---|---|---|
| 1 事前検査 | 他の run・資源の確認、DB の複製と gate（3.4）、policy floor を通る event 数の分布、serializer と prefix の確認、count_tokens | 0.5 |
| 2 arm A の composition | 実 renderer でダンプ（DB ごとに 1 回起動、10 問ずつ）、自前の検索との golden の一致 | 0.75 |
| 3 IR の選択・描画・hit label | ONNX の検索、policy の選択、2.4 の描画 | 0.5 |
| 4 body の純関数と全文 prefix | build_anthropic_chat_body との一致検証、C・D の byte 一致、cache の実測 | 0.5 |
| 5 質問と Gold | 生成、機械検査、別呼出しの検証、照合 sheet の作成 | 1 |
| 6 judge・誤受理率・集計の script | 4 節と 5 節の実装 | 0.5 |
| 7 Haiku の通し（探索） | p=30 の小集合で全 arm、費用・出力 token・cache・切れ率の実測。**直してよいのは bug と採点の規則の明確化だけ** | 0.5 |
| 8 事前登録の凍結 | Gold 照合の後。arm・質問・描画・選び方・配分・採点・費用・止める規則・主指標を contracts に hash で固定 | 0.25 |
| 9 Sonnet の本測定と Haiku の反復 | 実時間 4〜8 時間（監視）。凍結の後は arm・質問・描画・規模・主指標を変えない | 0.5 |
| 10 採点・較正・集計・記録 | judge、誤受理率、人の較正、records | 0.5 |
| 合計 | 実装と監視の作業日。ユーザーの待ち（Gold 照合 約 1 時間、較正 約 30 分）は別 | **約 5.5 日** |

v2 の 6〜8 日から、層 2・3 の arm（A_s の synopsis 生成、A′・A″、B_route 系）、別系列 judge、Opus の回答、p=30 を含む 100 問の設計を削って絞った。順序：1〜4 と 5 は並行できる。**Gold 照合の前は 8 に進まない**。

## 8 保存と records

- 本文を含むものはすべて repo の外：`/home/grimodex/fusion-eval-data/ir-chat-pilot-2026-11/`（権限 0700、ファイルは 0600）。質問・Gold・回答は原稿の事実を含むので repo に入れない。複製 DB、request のダンプ、回答、judge の出力もここ。**製品の保存範囲は変えない**。
- 送信ログに Authorization などのヘッダを書かない。renderer から repo 内へ戻すものは件数と enum に限る。Electron の userData と /tmp の一時物は実行後に消す。
- 保持：完了後 30 日で、ダンプと複製 DB は削除（または圧縮して退避）。質問・Gold・回答は残す。
- **records に入れる**：件数・字数・ID（質問 ID、Scene 番号、event ID）・型・根拠 Scene 数、質問集・Gold 集・回答集の**ファイル全体に 1 つずつの sha256**、arm 別の token・cache・費用・stop reason・並べ順、判定の enum、層別の集計、区間、棄却数、Gold の誤り率、judge の誤受理率、較正の一致率と κ、事前登録の hash。
- **入れない**：原稿の本文・題・抜粋、質問文、Gold の本文、回答の本文、IR の summary と quote、judge の説明文、項目単位の hash、質問や回答を例として引くこと。

## 9 先行事例の反映（chat-eval-prior-art-2026-11-07.md。照合が「一致」「一部」のものだけを根拠にする）

| 設計への反映 | 節 | 根拠（先行事例の節・ID・照合） |
|---|---|---|
| 位置までの本文＋根拠位置を Gold に必須。位置より後の漏れを根拠位置で機械点検 | 3.3、3.4 | §2 Q2 DetectiveQA（部）。位置で切る検索 §6 R1 TimeChara（一） |
| 型を複数箇所・時間・更新・棄権に寄せる。「原文に足す」設計（B・D） | 3.2、2.2 | §4 A8 LongMemEval（部）、§4 A6 ReadAgent（一）。NovelQA（§2 Q1）は「本」のみで根拠にしない |
| 答えられない質問を入れ、棄権と作話を別に数え、N は比較に入れない | 3.2、4 | §4 A8（棄権の型。部）、§6 R1（Future 型。一） |
| 項目の再現率と誤りの混入を別判定。partial を作らず二値 | 4 | §5 S13 ConStory（一／抜）、§5 S3 AutoNuggetizer（部／本）、§5 S1 FActScore（一） |
| Gold 項目は人が確認し LLM は照合だけ。Gold 側の誤りも多いので誤り率を併記 | 3.3、4 | §5 S3（部／本）、§5 S2 SAFE（一） |
| 曖昧な誤答を混ぜて judge の誤受理率を測る。全 arm で同じ prompt | 4、2.1 | §5 S12 LoCoMo 監査（一） |
| LLM 同士の一致は妥当性の証拠にならないので、judge は人の抜き取りで較正 | 4 | §5 S4 TREC 支持評価（一） |
| 入力 token と断片の並べ順を記録（取得量・並べ順で arm の優劣が反転しうる） | 2.1 | §4 A2 Xu（部）、§4 A3 OP-RAG（一） |
| oracle arm（O）で検索の失敗と読解の失敗を分ける | 2.2 | §4 A18 SummHay（部。Oracle 検索を上限に置く） |
| 0 arm と作品選び（g-ja-1 は AI 原稿）。文脈なしの正答率は作品で大きく動く | 2.2、3.1 | §3 M4 Bohnet（部）、§2 Q2（question-only の値。部）、§3 M3 XL²Bench（一） |
| 構造化の上乗せは数 pp、事前凍結し「差なし」も有効な結果とする | 1.2、5 | §4 A13 NS-ST-GraphRAG（一）、§4 A7 RAPTOR（部）、§4 A9 Zep／Mem0（一） |

引かない：自己選好の先行（§5 S6、S9。抜粋のみ）と cluster の標準誤差の倍率（§5 S14。抜／本）は、4 節・5 節で推測の扱いにとどめた。日本語の judge の人との一致率の先行例は無い（§1 の 7）ので自前で測る。

## 10 交絡と限界

1. IR の範囲：Chronicle の出来事だけ。製品の accepted-ir（Codex の Entity の型つき）は測れない。結論は常に「出来事の IR の block を足した効果」。
2. B−A は、文脈の量・検索単位と index・quote（Raw の断片）・要約文を同時に足す。分離（A′・A″ など）は今回しない。
3. 描画の新設：製品に Chronicle event の描画は無い。B は DD route の request ではない。IR は全件承認済みで、却下・編集が無い最大条件。
4. 製品の標準より薄い文脈（synopsis・codex・plot thread が空）。A は story_so_far なしの下限で、IR の増分が過大に見えうる。
5. 記憶：m-ja-2 は model が記憶で答えうる。0 arm で測るが消せない。両作品を合わせた主指標に混ざる。作品別を併記する。
6. 自己選好・自己一致：抽出・IR・回答・Gold・judge がすべて Anthropic 系列で、g-ja-1 の書き手と Gold の生成者は同系列。IR の効果を過大にしうる。人の抜き取りで較正するが、較正の範囲は限られる。
7. Gold：AI の下書きで、人が確認したのは約 30 問。未確認の約 50 問に誤りが残る。誤り率を併記する。
8. 検出力：数 pt の増分は検出できない見込み。cluster は 4。区間は広い。
9. 定型句（原稿の範囲で・分からなければそう答える）は製品の prompt に無く、棄権を強める。全 arm で同じなので差には効かないが、棄権率の絶対値は製品と違う。
10. Sonnet は 1 回で、揺れを直接測れない（Haiku の反復で代替）。adaptive thinking では temperature を固定できない。
11. IR の欠落（g-ja-1 の 11 Scene）。IR が答えられない質問が構造的にある。根拠 Scene の IR の有無で層別して記述する。
12. IR は圧縮ではない：g の p=117 で IR の statement と quote が前の原稿の約 0.7〜1.1 倍 [確認済・v2]。top-8 は量を抑えるが「短い索引」とは言えない。
13. 位置の交絡（C・D）：長文脈そのものと p より前に限った効果を arm だけでは分けられない。根拠 Scene の位置で層別して記述する。
14. 事実 QA は執筆支援の proxy。質問の分布は実際の作者の質問と無関係で、総合値に外的な意味は無い。
15. token 数は仮定（1.25 token／字）。count_tokens で上書きする。

## 11 閉じた問いと、ユーザーへの依頼

### 11.1 v2 の 18 の問いの閉じ方

| v2 の問い | v3 での扱い |
|---|---|
| Q1 送信内容、Q12 別系列、Q13 Opus の回答 | 決定 1（Anthropic だけ、OpenRouter・Opus の回答は使わない） |
| Q2 Gold の新設、Q10 標本確認の時間 | 決定 2（AI 下書き・約 30 問の人の確認）。**時間の依頼だけ 11.2 に残す** |
| Q3 arm の拡張 | 決定 3（0 と O を加えた 6 arm）。A_s・A′・A″ は不採用 |
| Q8 規模と位置、Q16 費用の上限 | 決定 4（80 問・$50）。閾値・同値の幅は置かない（integrator の既定） |
| Q4 層 3 の arm、Q18 D′ と再抽出 | 既定：今回は入れない（結論の言い方と限界に書く） |
| Q5 描画 | 既定：quote 付き 1 種類、位置はタイトルのみ、score 順（2.4） |
| Q6 現在 Scene と seed | 既定：現在 Scene は全 arm に入れる。seed は A と同じ（2.1、2.3） |
| Q7 IR の選び方 | 既定：製品の policy（floor 0.813、Scene 重複除去、最大 8 Scene）。地点は 59 と 117 |
| Q9 主の層 | 既定：主指標は 1 つ（B−A、両作品、答えのある全質問）。IR あり層・型別・D−C・C−A・O・0 は副（5 節） |
| Q11 結果の使い方 | 既定：探索の pilot。製品判断に使わず、正式な試験の規模と型の配分の材料（1.2） |
| Q14 保存 | 既定：repo の外の既存の置き場の下、records は件数・ID・位置・sha256・判定のみ。製品の保存範囲は変えない（8 節） |
| Q15 count_tokens | 既定：使ってよい（同じ送信先）（6.1） |
| Q17 API の干渉 | 既定：CP-4 の正式 run と重ねない。並列度は全文 arm 2、小さい arm 8 まで。429 で半減（1.2、6.4） |

integrator の既定の理由：閾値や採否の規則は、事前登録された Gold・閾値の新設に当たる。pilot の目的は規模の決定の材料なので、推定と区間だけで足りる。arm A は製品の検索を実 renderer で動かすので CP-4 と重ねない。追加 arm と再抽出は、効果の分離に費用と手順が増え、今回の問い（IR の block を足した効果）の外。

### 11.2 実行の前にユーザーに頼むこと

- **Gold の 30 問の照合（抜粋だけ、約 30 分。原稿は通して読まない。N は除く）**。sheet は repo の外に作る。型・作品・地点で層別。判定項目は 3.3。これが済むまで事前登録の凍結（手順 8）に進まない。取れなければ、結論に「Gold 未確認」と明記して限定する。

### 11.3 実行の後に頼むこと（任意）

- judge の較正の抜き取り（約 40 項目、約 30 分。4 節）。取れなければ結論を「judge 未較正」に限定する。

## 12 CP-4 などとの順序

- 設計と確認は read-only で、他の lane を止めない。CP-4 の正式 run や他の評価 run が走っている間は、評価の worktree と profile に触れない。API は key・org の rate limit・費用を他の run と共有するので、走行の有無（process と API 呼出し）を開始前に確かめる。
- lane の順（DR-IRB-3 → IR query 高速化 → #798 → PUB-G の前提）には割り込まない。#798 の dump-run は手本として読むだけで、その枝が動くまで触れない。
- 着手の順：(1) 事前検査と資源の preflight → (2〜4) harness → (5) Gold の生成 → **ユーザーの照合** → (7) Haiku の通し → (8) 凍結 → (9) 本測定 → (10) 採点・記録。凍結までは count_tokens を除き、本測定の API を呼ばない。
