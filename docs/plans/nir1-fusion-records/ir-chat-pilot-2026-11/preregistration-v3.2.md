# 実製品の chat で IR は質問に効くか — pilot の設計と事前登録（v3.2 凍結稿）

状態：**凍結稿 v3.2**（凍結の手順は 7.3。凍結そのもの＝manifest の作成と contracts への commit は integrator が行う）。ユーザー決定 3 件（2026-11-07、AskUserQuestion）と、Opus のレビュー 10 件の直し、Haiku の通しの作り直し、Sonnet の小さい通し（$1.42）、凍結前の Opus のレビュー（P1 5 件・P2 6 件・P3）の直し、integrator の決定 4 件（0.1 の決定 8〜11）を反映。**本測定は行っていない。ユーザーに残る依頼は無い**（11.2）。API は、count_tokens（費用 0）、Haiku の通し・judge、Sonnet の通し（p=30 の 12 問×6 arm）だけを呼んだ。
日付：2026-11-07。基点：origin/master 73c48507（製品コードは v2 で git show により read-only で確認した範囲を引き継ぐ）。max_tokens の照合だけは origin/master a2309b95 で読み直した（2.1）。
表記：[確認済]＝DB・コード・先行事例の照合で確認、[推測]＝計算または仮定、[未確認]＝まだ見ていない。
規則：原稿の本文・質問文・Gold・回答・IR の statement と quote は repo に入れない（8 節）。この文書も本文を含まない。

## 改訂の履歴

- v3.2（2026-11-07）：下の 3 つのユーザー決定と、レビューの直し（IR の seed・judge の参照・(b) の定義・max_tokens・型別の集計・誤受理の測り直しの準備・人の照合の誤り率・hash の記録・逸脱の追補・未確認の確かめ）を反映。変えたのは 0.1 の決定 5〜7、2.1（max_tokens・thinking）、2.3・2.4（IR の選び方・IR_INTRO）、3.1（作った問いの数）、3.3（人の照合の誤り率）、4（judge v3・(b)・誤受理・照合）、5（型別・並びの注記）、6（費用の全面改訂）、7.2（進捗）、8（records）、10（限界 16〜21）、11（残る依頼）、12（走行の guard）。質問・arm・配分・主指標・Gold の答えは変えていない。
- v3.2 凍結稿（2026-11-07）：凍結前のレビューの直し。integrator の決定（旧 11.2 の 1〜4）を本文に入れた（0.1 の決定 8〜11、2.1、6.3、6.4、4）。主指標の母数を 67 問に揃え（5）、除外と欠測の規則（6.5）、(b) の確定値（4）、項目の再現の正本（4）、judge の候補率を arm 間で比べない注記、凍結の対象と manifest（7.3）、n-gram の基準の実際の値（3.3）、中断の際に途中の結果を採点しない規則（6.4）、誤受理の測定の限界の追記（10 節の 22〜23）、thinking・effort の確認結果（11.4、限界 24）、費用の注記（6.2、6.2.1）を足した。本測定の runner と集計（main-run.mjs・analysis-lib.mjs）を実装した。質問・arm・配分・Gold の答えは変えていない。
- v3.1（2026-11-07）：人の照合を「抜粋だけで 30 問、N を除く、約 30 分」にした（ユーザーの決定。原稿を通して読まない）。

- v1：初版。v2：レビュー 38 件を反映（precheck の新設、arm の 3 層化、18 の問い）。
- v3（2026-11-07）：v2 の 614 行を絞り直した。
  - 決定 4 件を反映：送信と judge は Anthropic のみ／Gold は AI 下書き＋人の抜き取り／arm は 6 つ（0 と O を追加）／規模は 80 問（作れた Gold は 79 問）・上限 $50（決定 6 で $60）。
  - v2 の 18 の問いを閉じた（11.1）。残る依頼は Gold の約 30 問の照合だけ。
  - 先行事例調査の §7 を設計に入れた（9 節）：根拠位置の必須化、答えられない質問と棄権・作話の分離、項目の再現率と誤りの混入の分離、judge の誤受理率の測定、全 arm 共通の prompt、token と並べ順の記録。
  - 削除：層 2・3 の arm（A_s、A′、A″、B_route、B_q、B2、B_ord）、OpenRouter、Opus の回答、結果→判断の表、p=30 を含む 100 問の設計、v2 の 6〜8 の費用表。

## 0 precheck（GDX-PRECHECK-001）

外部送信、長時間実行、prompt cache、Electron の subprocess を含むので、NIR-1 の事前委任の外で扱う。

### 0.1 ユーザー決定の記録（2026-11-07、AskUserQuestion で 1 回。選んだ選択肢の逐語の要旨）

1. 送信と judge：**「Anthropic だけ」**。原稿の全文・IR・質問・回答・judge の入力は、すべて Anthropic の API にだけ送る（抽出のときと同じ送信先）。judge も Anthropic の model。人が確かめた Gold の項目との照合に限り、人の抜き取りで較正する。自己選好の恐れは限界として書く。OpenRouter は使わない。
2. Gold：**「AI が下書き・一部を人が確認」**。AI が位置 p より前の原稿から、IR と独立に、質問・事実の項目・根拠の位置を作る。ユーザーが約 30 問を照合する（約 1 時間）。誤り率を結果に併記する。
3. arm：**「本文なし＋根拠だけ」を足して 6 arm**。(0) 質問だけ、(A) 製品相当の Raw、(B) A＋出来事の IR、(C) 位置より前の全文、(D) C＋出来事の IR、(O) Gold の根拠の段落だけ。
4. 規模：**「80 問・上限 $50」**（予定。作れた Gold は 79 問で、g-ja-1-p59 が 19 問。上限は決定 6 で $60）。2 作品（g-ja-1 が主、m-ja-2 は参考）×2 地点×20 問。回答は Sonnet 5.5 high を 1 回、反復の確認は Haiku 5.5 low。

5. （2026-11-07、v3.1 の後）**B・D の IR は、評価側が『質問本体＋現在 Scene の末尾 500 字』の seed で選ぶ**。製品の IR 経路は query に質問を載せられない（QUERY_SOURCE_CHANGED）ので、質問に依らず同じ行になるため。埋め込み model（ruri-v3-30m）と選択の policy は製品と同じ。製品の経路との差は限界に書き、製品の経路で取った行は参照として records に残す。
6. **費用の上限は合計 $60**（旧 $50）。段ごとの上限は設計の考え方で配り直し、6.2 に書く。台帳の送信前の gate も $60。
7. **judge は Haiku 5.5 の API**（prompt は hash で凍結）。**judge を確かめる Sonnet の照合は subagent で行う**（原稿を読むため。API ではない）。照合の盲検化を仕組みで守れないことと、照合の道具（Claude Code の system と tool）が固定されないことを限界に書く。

8. **（integrator の決定。旧 11.2 の 1）max_tokens は製品と同じ 4,096 のまま**。切れた回答は製品の挙動として扱い、arm ごとに数えて報告する。6.4 は、最低 20 request を見てから切れが 2％ を超えたら中断し、integrator が見直す（runner の TRUNCATION_MIN_REQUESTS＝20 と一致）。中断の後の判断は逸脱として記録する。
9. **（旧 11.2 の 2）縮小の規則の値は $50**（上限 $60 に比例）。中央値は超えないので縮めない（6.3）。
10. **（旧 11.2 の 3）Sonnet の照合（subagent）は judge の後、採点の段で行う**（約 250 件）。盲検化・道具の限界は結果に書く（限界 18）。
11. **（旧 11.2 の 4）B・D の IR が質問つきの seed であることを結論の文言に入れる**（1.3、1.5）。B−A は『chat に質問で IR を引く経路をつないだ場合の見積り』であり、製品の今の IR の経路（質問を載せられない）ではない。
12. **（2026-11-07、ユーザーの再確認）Sonnet の effort は high のまま**。製品の chat の既定が medium（`getEffortForTask("chat")`、origin/master a2309b95）であることを示した上で、ユーザーが「high のまま」を選んだ（AskUserQuestion。推奨は medium だった）。製品の既定との違いは限界 24 と結論の文言に書く。

決定 1 により、v2 の送信の個別確認（旧 Q1、Q12、Q13、行 h・j）は済み。

### 0.2 actor・送信先・保持・停止点

| 項目 | 内容 |
|---|---|
| actor | 評価 harness（別 process の Node script）、Electron の renderer と main（arm A の文脈のダンプだけ）。評価用の keyring の Anthropic key（値は表示・記録しない） |
| 送信先 | Anthropic の Messages API と、同じ API の count_tokens だけ。ほかは無し |
| 送るもの | 位置 p までの原稿（作品ごと。Gold の N 型だけは p より後も）、IR、質問、Gold、回答（gen／回答／judge 用）。key・profile・他プロジェクトのデータは送らない |
| 送信内容×model | Gold の下書きと検証：Sonnet 5.5 high。回答：Sonnet 5.5 high（本測定 1 回）、Haiku 5.5 low（通し・反復）。judge：Haiku 5.5 low（API）。judge の照合は Sonnet 5.5 の subagent（API ではない。原稿を読む）。Opus は使わない |
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
- **B・D の IR は、質問つきの seed で評価側が選んだもの**で、製品の今の IR の経路（質問を載せられない）ではない。B−A は『chat に質問で IR を引く経路をつないだ場合の見積り』で、『製品が今できること』ではない（限界 16）。
- 正式な試験の規模の見積り：観測した不一致率と cluster の相関から、必要な質問数と作品数を計算する。

### 1.4 言えないこと

- 「IR 一般」の効果。第 6 版の DB の IR は **Chronicle の出来事だけ** [確認済：g-ja-1 は proposal 884 件、すべて `chronicle.create-event@1`・承認済み、Codex の項目と関係は 0 件。integrator が DB の写しで確認]。製品の packing の accepted-ir（Codex の Entity の型つきの改訂）は**測れない**。製品の route の request でもない（B は A への上乗せ。2.3）。
- 窓の小さい local model での圧縮効果、agent の tool を使うモード、製品の実利用（synopsis・codex・chronicle snapshot が入った文脈。評価 DB では空）、鮮度や枠の大きさの効果、作品をまたぐ一般化。
- 事実 QA は執筆支援の proxy にとどまる。

### 1.5 結論の文言（事前登録）

結果の報告は次の言い方に限る。
- 『出来事の IR の block を足した効果（文脈の量・検索単位の違い・quote の追加を含む）』と書く。『IR の効果』とは書かない。
- B・D の IR は質問つきの seed で評価側が選んだものである。**B−A は『chat に質問で IR を引く経路をつないだ場合の見積り』**であり、製品の今の IR の経路（質問を載せられない）の効果ではない。
- 主指標は答えのある 67 問の B−A。確認済みの 30 問の部分集合は副指標。N の 12 問は主指標に入れない。
- 区間は広く、有意差は出ない見込み。『差なし』も有効な結果として記録する。製品判断（経路の開閉、鮮度、枠の大きさ、PUB-G）には使わない。
- 回答の条件は製品の既定と違う（Sonnet は effort high で製品の chat の既定は medium、定型句あり、history なし）。限界 24 を併記する。

## 2 arm

### 2.1 共通の固定

[確認済・v2 から引継ぎ] 製品の chat は chatContextPreparationComposition.capture／prepare → prepareTurn → planChatContext → buildSystemPrompt の順で request を作る（mode="chat"、tool なし）。**全 arm で同じ**にするもの：

- system の土台（chatSystemBase、DataBoundaryReminder、tag 構造）は製品の buildSystemPrompt の出力を使う。自前の再実装はしない。
- **同じ reader・同じ prompt**：user message は質問本体と、別の 1 文の定型句（「ここまでの原稿の範囲で答えてください。原稿から分からないことは分からないと答えてください」の趣旨）だけ。history なしの単発。定型句は棄権・作話を測るために必要で、製品の prompt に無い（棄権が強まりうる。10 節）。検索の seed は定型句を除いた質問本体で作る。
- 現在の Scene（Scene p の本文）を current_scene として**全 arm に入れる**（製品と同じ）。
- answer model・effort・max_tokens は事前登録で固定。Sonnet 5.5 は effort high、Haiku 5.5 は effort low（**製品の chat の既定の effort は medium**。ユーザー決定により Sonnet は high。限界 24）、thinking は `{type:"adaptive", display:"summarized"}`（製品の buildThinkingParams の既定。製品が実際にこの thinking・effort を送ることは origin/master a2309b95 で確かめた。11.4、records の F19）。**temperature 等の sampling 引数は送らない**。**max_tokens は 4,096（thinking を含む）**＝製品の chat と同じ値 [確認済：origin/master a2309b95。renderer の resolveTurnRoute が resolveOutputBudgetPlan（provider anthropic・manual の thinking budget なし）で defaultVisibleOutputTokens を求める。Sonnet 5.5／Haiku 5.5 の能力表（ANTHROPIC_GEN5_CAPABILITIES）は既定値を持たないので 4,096。chatTurnStoreActions の chat_stream_non_agent がこれを requestMaxOutputTokens として Rust に渡し、grimodex-ai の effective_request_max_output_tokens は override を優先する。override が無いときの Rust の既定は thinking 常時 on の世代（5 以降）で 32,000 だが、chat の通常経路では使われない]。評価の request と製品の body の差：製品は `stream:true`（評価は非 stream。usage・stop_reason・課金は同じ）。評価は history なしの単発。model・max_tokens・messages・system（cache_control の付き方）・thinking・output_config と anthropic-beta（prompt-caching-2024-07-31）は同じ形。出力は実際の token で課金されるので、max_tokens を上げても費用は増えない（Sonnet の通しの出力は最大 2,087 token で、4,096 に達した request は 0／72。決定 8：4,096 のまま。切れた回答は製品の挙動として得られた本文のまま採点し、切れの件数を arm ごとに報告する。6.4 で最低 20 request を見てから切れが 2％ を超えたら中断し、integrator が見直す。中断の後の判断は逸脱として記録する）。
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

- **IR の選び方**（ユーザー決定 5）：評価側（ir-select.mjs）が、seed＝質問本体＋現在 Scene の末尾 500 字（arm A と同じ seed。質問本体は定型句を除く）を ruri-v3-30m で埋め込み（query 側の prefix と byte fallback の補正は製品の埋め込みと cosine 0.998 以上で一致を確認）、event の保存済み vector との cosine で並べ、**製品の policy**（policies/narrative/nir1-related-scenes-ranking.json）で選ぶ：ja の cosine floor 0.813、Scene で重複除去（1 Scene につき最高スコアの event 1 つ）、最大 8 Scene。Scene < p の event だけが候補。**質問依存になる**（同じ cell でも質問ごとに行が違う）。floor を通る event が 0 件なら IR 0 件として記録（floor は変えない）。本測定の 79 問では floor を通る event は 12〜470 件、8 件に満たない質問は 0 件。
- **製品の経路との差（限界 16）**：製品の経路は質問を載せられず、第 6 版の probe（現在 Scene の末尾だけの query）の選択とも、8 件の集合の完全一致は g-ja-1 で 15/29、m-ja-2 で 11/29（他は 7〜8/8 の重なり。差は 8・9 位の cosine 差 0.002 以下）。評価側の選択と製品の経路で取った行（質問に依らない）の重なりは、本測定の 79 問で平均 4.2／8 件（最小 0、最大 7）。**製品の経路で取った行は参照として records に残す**（irSelection.overlapWithProductPath）。
- **根拠 Scene との重なり（質問依存になった効果）**：答えのある 67 問の根拠 Scene（延べ 147）のうち、IR に入った Scene は評価側の選択で 67（46％）、製品の経路で 29（20％）。根拠 Scene が 1 つ以上 IR に入った質問は評価側で 47／67、製品の経路で 22／67。B−A の差は、この重なりの増えた分だけ大きく出うる（検索の hit label は結果の前に機械で付ける。3.5）。
- 位置 p ごとに IR の index を作り直さない。event は Scene をまたがない [確認済・v2：1 Scene 1 run、eventId 884／884 一意]ので、Scene < p で切れば位置 p の時点の集合と同じ。

### 2.4 IR の描画（評価専用・1 種類）

製品に Chronicle event を chat に出す描画は存在しない [確認済・v2]。評価専用に **quote 付きの 1 種類**とする。

- 1 event を数行：位置（Scene のタイトルのみ。序数・段落番号なし。製品の related_scenes と同じ粒度）、summary（約 75 字）、actuality／attribution／narrativeFrame、人物の表層・場所・時間表現（ある場合）、根拠の quote（evidenceSet 全件）。
- 並びは score 順（Scene の昇順にすると序数の手がかりを与えるため）。導入文は『質問と現在の場面の末尾に関連が高い順』（評価側の選択の事実に合わせた。旧『質問との関連が高い順』を直した）。量は 8 event で約 1〜2.6K 字 [推測]。
- 描画の文言は評価専用で、製品の UI 文言や契約ではない。

### 2.5 arm C・D・O

- **C**：Scene 1〜p−1 の全文を、story_so_far の位置（current_scene の前）に 1 つの block として入れる。見出しは「Scene N」の素の番号だけ。related_scenes は入れない。大きさ [確認済・原稿の字数]：g-ja-1 は p=59／117 で 101,130／208,344 字、m-ja-2 は 106,929／199,205 字。1 prompt は約 130k〜260k token（6.1 の仮定）、窓 1M 以内。
- **D**：C の request に B と同じ手順・描画の IR block を、原稿の後ろ・質問の前に追加する。C と D は current_scene までの prefix を byte 一致にする。B−A は「情報の補給」、D−C は「注意誘導と妨害」で、別の量として読む。
- **O**：Gold の各項目の根拠（Scene 番号＋原文の抜粋を含む段落）を原文のまま渡す。要約・構造・IR は無し。

## 3 質問と Gold

Gold の新設は決定 2 で承認済み。この pilot の Gold は not-cp4-evidence として分離し、既存の Gold・台帳には触れない。

### 3.1 規模と位置

- 2 作品（g-ja-1 が主、m-ja-2 は参考）×2 地点（p＝59 と 117）×20 問の予定。**作った Gold は 79 問**（g-ja-1 は p=59 で 19 問、他の 3 cell は 20 問。機械検査・別呼出し・全文検証で棄却した 1 問は補充しなかった）で、答えのある 67 問（E 16、M 15、T 12、U 8、R 8、K 8）と N 12 問。1 問は 2〜3 個の検証できる事実の項目に分ける（本測定の 67 問で約 170 項目）。
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
- 型の配分は事前登録で固定する。全体で答えのある問いは 67 問（予定の 68 から 1 問減）。

### 3.3 作り方と検証

- **生成**（Sonnet 5.5 high。IR を入力に使わない）：Scene 1〜p−1 の本文だけを渡し（N の後の Scene の事実だけ全文を渡す）、型・根拠の層を指定して、質問・事実の項目・**根拠の位置（Scene 番号＋原文の逐語の抜粋）**を出させる。質問は原文の語句を写さず、作者が chat で聞く自然な言い方（口語・言い換え）にする。
- **機械検査（すべて通す）**：根拠の抜粋が原稿の該当 Scene に逐語で存在する。根拠の Scene 番号がすべて p 未満（N の後ろの事実を除く）。質問に p 以降にしか出ない固有名が無い。質問と根拠の重なりが基準以下（FTS5 と dense の検索を当たりやすくする転記を除くための基準。**生成の前に固定し、実際に使った値**：根拠の段落との最長の共通連続が 12 字以上なら棄却、4-gram の比が 0.3 を超えれば棄却。全文との連続コピー 12 字以上は棄却し、全文との 4-gram 比 0.5 は参考値で棄却に使わない。受理した最大は、根拠の段落との共通連続 11 字・4-gram 比 0.222、全文との参考値 0.588。出所は gold 枝の checks.mjs の EVIDENCE_OVERLAP／OVERLAP と、records の goldOverlapThresholds）。
- **別呼出しでの検証**：O と同じ入力（根拠の段落だけ）で Sonnet 5.5 high が答え、Gold と食い違う問いを棄却または直す。N は、Scene < p の全文を渡した Sonnet が「分からない」と答えることを確かめる。型別の棄却数を records に出す。
- **人の確認（実行の前。済み。11.2）**：答えのある型（N を除く）から型・作品・地点で層別した 30 問を、ユーザーが sheet で照合する。**原稿は通して読まない**（ユーザーの決定 2026-11-07「抜粋だけで 30 問」）。sheet には問いごとに、質問、事実の項目、根拠の逐語の抜粋とその前後の数段落だけを載せる。判定は 2 点：抜粋が項目を支えているか、質問が曖昧でないか（1 問 1 分前後、計約 30 分）。N は全文の知識が要るので人の照合から外し、機械の検査と全文を渡した Sonnet の検証だけにして、結果に「N の Gold は人が確かめていない」と書く。**誤り率（直し・棄却の割合）を Wilson 区間つきで結果に併記**する。**結果：1/30**（g-ja-1-p59-E2 の根拠不足を直しとして数える。Wilson 95％ [0.006, 0.167]。旧記録は 0/30 [0, 0.114] だったが、指摘を『誤りなし』に数えていたので直した）。**照合の範囲**：抜粋が項目を支えるか、質問が曖昧でないか。**M・U・K の網羅（項目の取りこぼし）と、後の Scene による更新の見落としは見ていない**。残りの答えのある 37 問と N の 12 問は人が確かめていない。確認しなかった約 50 問は未確認として扱う。**主指標は答えのある 67 問（N を除く）で出し、確認済みの 30 問の部分集合は副指標として別に出す**。
- g-ja-1 の outline.md は書き手の意図で、本文と食い違う軽微な矛盾が約 25 件ある [確認済・v2]。候補の出所にとどめ、本文で検証した項目だけを Gold にする。AI が生成者かつ g-ja-1 の書き手と同系列である点は限界（10 節）。

### 3.4 DB の切り方と漏れの検査

複製の手順（元の run の DB は開かない）：

1. 元 DB（runs-ir の下）が完了済みで書き手がいないことを確かめる（run の process が無い、-wal が空か無い、更新時刻が変化しない）。
2. -wal／-shm を含めて file copy し、前後の sha256 で元の不変を確かめる。複製側で integrity_check、件数を元の記録と照合。
3. 複製側で Scene > p を切る：tree_nodes、scene_chunks とその embedding、FTS5（rebuild）、IR の proposal・vector・observation、そのほか Scene 番号を持つ表（一覧は schema から作る）。dense の pool と sparse の上位は切った集合で作る。作品 2×地点 3（59・117・通し用の 30）＝6 個。
4. **harness の gate（1 つでも不一致なら止める）**：p より後の scene ID が全表・全 index で 0 件。project_info・章・Scene のタイトル・plot thread に後の内容が無い。chunk の neighbors が p より後を指さない。
5. **request の漏れ検査**：ダンプした全 request で、Scene > p の本文の 20 字の shingle が 0 件ヒット（N の質問の生成 prompt は除く）。

### 3.5 label（結果の前に機械で付ける。選別でなく層別）

根拠 Scene に IR の event があるか／検索の hit（A の chunk に Gold の根拠段落が入ったか、B の選択の根拠 Scene が Gold を含むか）／Scene p だけで答えられるか（Scene p だけを渡した Haiku。入力は Haiku の arm 0 と同じ。79 問×1 回で約 $0.03、answer-haiku の段に含める。6.2.1）／根拠 Scene の数（1／2〜3／4 以上）と位置／推測可（0 arm で Haiku・Sonnet のどちらかが答えた項目）。IR の有無や hit で質問を選別しない。

## 4 採点

- **項目の再現率と誤りの混入を別の判定にする**（9 節）。(a) 再現率：Gold の項目ごとに、回答がそれを含む／含まない（言及なし）。partial は作らない二値。**判定の厳しさ**：項目の核の一つでも食い違えば false、候補を並べて決めていなければ正解を含んでいても false（設計の『含む／含まない』より厳しい。全 arm 共通。再現率の絶対値は低めに出る。HP-8）。
- **(b) 誤りの混入**（設計の定義：Gold の項目または根拠の段落と矛盾する、または原稿に無い主張＝作話）：judge が flag を 3 つ出す。**contradiction**（食い違う主張を決めた形で述べた）、**hedged**（互いに両立しない候補を並べて決めていない。正解を含んでいても true。設計どおり (b) の矛盾に数える）、**unverified**（質問の答えの中核の主張が、参照の段落だけからは確かめられない。誤りの確定ではない）。**(b) の候補＝contradiction か hedged か unverified**。judge 側の陽性（contradiction か hedged）と、候補（unverified も含む）の両方を arm 別に出す。**作話・矛盾の確定は Sonnet の subagent の照合（原稿全体）で数える**（下の (3)）。
- **(b) の確定値（事前登録）**：**主の値（下限）＝ judge の hedged ∪（S2 のうち、照合者が S2 で contradiction か fabricated_claim を確定した回答）**。judge の hedged は照合で覆さない（照合の指示書も同じ規則）。judge の contradiction・unverified は候補で、照合者が確定したものだけを下限に数える。**S3（残りの 25％）からの見逃し率 r**（S3 のうち照合者が contradiction か fabricated_claim を確定した割合。pooled、Wilson 区間つき）は別に出し、**点推定は副**として `（下限の件数 + r × S2 に入らなかった回答の件数）÷ 判定済みの回答の件数`（r の区間の両端でも）で書く。N 型の棄権・作話の正本は S1（照合者）。実装は analysis-lib.mjs の confirmBMixing。
- **項目の再現の正本**：主指標は **judge v3 の reproduced だけ**で出す。機械照合（mechanicalVerbatim）と照合者の items は一致の監査にだけ使い、**不一致率を報告する**（機械が一致なのに judge が false の項目の割合、照合者と judge の項目の不一致率）。主指標には混ぜない。
- **judge の (b) の候補率と unverified 率は arm 間で比べない**。judge の参照は根拠の段落だけなので、根拠の段落の外の事実を述べやすい arm（C・D・O）で候補・unverified が高く出る偏りがある。arm 間の誤りの比較は、照合者が原稿全体で確かめた確定値（下限）で行い、それも S2 の標本の範囲に限る。
- **N 型**：「分からない」と述べれば棄権（正）、具体的な答えを述べれば作話。答えのある質問での棄権（過剰棄権）と N での作話を別に数える。N は arm 間の正答率の比較に入れない。
- 3 段：(1) 固有名・数は機械で逐語照合、(2) 言い換え・含意は **Haiku 5.5 low の judge（prompt v3。sha256 80eaa8fb156f7c287f3c5d768a0123a60fdea28189b48b8046ad6ab7e5c57be2）**。入力は質問・Gold の項目・**根拠の段落**（arm O が回答者に渡すものと同じ原文。N 型は注記）・盲検化した回答だけ。参照は人が検証した原稿由来のものを必ず与える。(3) **Sonnet の subagent の照合**（API ではない。原稿全体を読む）：judge の出力の無作為 25％と、(b) の候補の全件と、N 型の全件。**judge の後、採点の段で行う**（決定 10）。空の回答と refusal の回答（judge を呼ばず棄権として採点したもの）は含めない。**抽出の規則と種は事前登録で固定する**（verify-materials.mjs。種 `ir-chat-pilot-2026-11-verify-v1`、率 0.25、id の昇順で走査し、S1＝N の全件、S2＝(b) の候補の全件、S3＝残りの 25％。照合者に見せる順は種つきの shuffle で、arm・rep・judge の判定・選ばれた理由は見せない）。Sonnet の通し（72 回答）で試すと 38 件（S1 12、S2 15、S3 11）、Haiku の通し（168 回答）で 93 件。本測定の Sonnet の回答 474 では 250 件前後と見込む。照合の指示書の下書きは data の verify-instructions-draft.md（実行は凍結の後）。
- **judge の prompt の版と hash**：v2（通しの作業で使った版）3fa3ecd35541c6ce2ab19c1739051f327f0d0cd2e8b51e68d62d7ef6b30c67af、v3（凍結する版）80eaa8fb156f7c287f3c5d768a0123a60fdea28189b48b8046ad6ab7e5c57be2。v1 の本文は commit に残っておらず hash は無い。
- **盲検**：採点の前に回答から位置表記（Scene・段落の言及）と IR 特有の書式を除く。judge には arm 名を渡さない。**盲検の限界**：相対的な位置表現（『前の場面で』『直前に』『最初のほうで』）、文体と長さの差（O・C・D は引用や言い換えの形が違いうる、0 は『分からない』が多い）は除かない。judge と照合者は、これらから arm を推測しうる。
- **judge の誤受理率の測定**（本測定の Gold で測り直す準備を済ませた。人手で作成。API 生成は使わない）：Gold の答えのある 67 問から、cell ごとに型を種つきで round-robin に 5 問、計 20 問（E4・M3・T3・R3・K4・U3）を選び、各問について 3 種の誤答（具体的だが誤った答え＝specific-wrong、互いに両立しない候補を並べて決めない＝hedge-list、一般的で空疎＝vague）と、**陽性対照**（正答の言い換え。judge が全項目を再現と判定し、誤りの flag を付けないのが正）を作る。**結果（judge v3、各型 20 問）**：誤受理（いずれかの項目を再現とした回答）は specific-wrong 0/20（Wilson 上限 0.16）、hedge-list 0/20（0.16）、vague 1/20（0.24。項目 1 つ分）。hedge-list は 20/20 が hedged、specific-wrong は 20/20 が contradiction。陽性対照は 20/20 が全項目の再現、誤りの flag 0/20。**限界**：誤答は 1 人（Claude）が書いた定型寄りの文で、実際の model の誤答より検出しやすい（hedge-list は『〜とも〜とも読め』の形）。**誤答の作者と judge の prompt の作者が同じ（Claude）で、hedge-list の書き方が v3 の規則の例に寄っているので、誤受理率は楽観的に出る**。陽性対照に『正しい項目に別の場面の真の事実が混ざった回答』が無く、その場合の誤 flag・誤受理は測っていない（限界 22・23）。vague の 1 件は、誤答の側が項目 0 を実質述べていた（作り方の誤りで、判定は妥当）。judge と誤答の作者が同系列。
- **judge の自己一致**（同じ盲検回答をもう一度 judge。flag ごと。Haiku の通し 168 回答）：項目 381/392（κ 0.94）、contradiction 157/168（κ 0.77。陽性は 1 回目 31・2 回目 26・両方 23）、hedged 168/168、unverified 163/168（κ 0.53。陽性は両方 3、どちらか 8）、abstained 167/168、fabricated 167/168。**陽性が少ない flag は一致率だけでは足りず、陽性の一致（contradiction で 23/34）と κ を併記する**。誤受理の測定（本測定の Gold）では、再判定で全項目が一致した（項目 188/188、contradiction 80/80、hedged 80/80）。
- **v1・v2 の誤答と judge の版の比較**（各型 10 問。予備。区間が広い）：v1 の誤答 × judge v1 の誤受理は specific-wrong 2/10、hedge-list 1/10。v1 の誤答 × judge v2 は 1/9・0/9（3 件は judge の出力が壊れて判定できず）。v1 の誤答 × judge v3 は 1/10・0/10。v2 の誤答 × judge v2 は 0/10・0/10・0/10（hedge-list の contradiction の検出は 6/10）。v2 の誤答 × judge v3 は 0/10×3（hedge-list は hedged 10/10）。誤答の作り直し（HP-3）と judge の改訂（HP-2・HP-9）の効果は、この表で分けて読む。
- **人の抜き取りでの較正**（実行の後。11.3）：arm・回答の長さで層別した約 40 項目をユーザーが判定し、judge との一致率・κ・**差の向き**（judge が寛容か厳密か。arm ごと）を出す。取れなければ結論を「judge 未較正」に限定する。
- **自己選好・照合の限界**：抽出・IR・回答・Gold・judge・照合がすべて Anthropic 系列で、自己選好が一方向に効きうる。Sonnet の照合は、**盲検化を仕組みで守れない**（回答の文体・長さ・相対的な位置表現から arm を推測できる）うえ、**Claude Code の system prompt と tool が固定されない**（版で変わりうる）。照合者が原稿を読み切れずに見落とす誤りも残る。先行の裏づけは照合が弱い（抜粋のみ）ので推測の限界として書く。Haiku と Sonnet の両方の差を出す。

## 5 指標と分析

（v3.2）T（順序）と U（更新）は型別の集計で単独に出す（summarizeByType）。arm O の並びは Gold の根拠の順でほぼ Scene の昇順（Scene が 2 つ以上の質問で昇順は 43／48（本測定の 4 cell））、A・B は score 順で、B の IR は昇順 0 件。**O−A・O−0 の T・U には、O の並びが答えの手がかりになる分が混ざる**（records の fragmentOrder）。Sonnet の通し（T 4 問）では O の T は 0.33 で C の 1.0 を下回り、根拠の段落だけでは順序が決まらない問いがある兆候（4 問なので記述にとどめる）。

- 質問の点数＝その質問の Gold の項目のうち「含む」の割合。
- **主指標（1 つ）**：Sonnet 5.5 の回答で、両作品を合わせた **B−A の項目の正答率の差**（答えのある 67 問、N の 12 問を除く。質問単位の対応のある差の平均。質問の点数＝その質問の Gold の項目のうち judge v3 が reproduced とした割合）。
- **副（記述。検定しない）**：**確認済みの 30 問の部分集合での B−A**、根拠 Scene に IR がある層（B の IR が根拠 Scene を 1 つ以上含む質問）での B−A、**型別（E・M・R・K と、T（順序）・U（更新）を分けて出す。T と U は 1 つにまとめない）**、作品別（g-ja-1 を先に）、地点別、D−C、C−A、O−0、O−A、B−0。推測可を除いた版。(b) 誤りの混入率、過剰棄権率と N の作話率（arm 別）、検索の hit 別の正答、arm 間の不一致セルの件数、Haiku の揺れ。
- **区間**：質問を単位とする対応のある差を、cell（作品×地点）で層別して復元抽出する bootstrap の 95％区間（percentile 2.5／97.5）。**種 `ir-chat-pilot-2026-11-bootstrap-v1`、反復 10,000 回を事前登録で固定**（比較ごとの種は `<種>:<比較名>`。analysis-lib.mjs）。cluster（作品×地点＝4）は、1 cluster を除いた推定値 4 個の範囲を併記する（cluster bootstrap は 4 では不安定）。p 値と採否の閾値は出さない。
- **Haiku の反復**：0・A・B・O は全質問を 3 回、C・D は 1 回。同じ arm・同じ項目の判定が割れる割合を揺れの目安とする。Haiku の数値は Sonnet に持ち越さない（Sonnet は 1 回のため、揺れを直接は測れない。限界）。
- **検出力 [推測]**：答えのある 67 問、不一致率 0.2 で、検出できる最小差は約 15 pt、cluster の相関で実効 n が減るとさらに大きい。先行の増分は数 pp（9 節 A13、A7）で、**この pilot で有意差は出ない見込み**。成果は、差の推定と区間、型・label 別の観察、正式な試験に必要な質問数と作品数の見積り。

## 6 費用の再見積り（上限 $60）

実測の根拠：Sonnet 5.5 の小さい通し（p=30 の 12 問×6 arm×1 回、effort high、本測定と同じ request の形。**$1.42**、judge $0.03）。計算は reestimate.mjs（cost-reestimate-v3.2.json）。

### 6.1 実測と前提

- **価格 [確認済：価格表 2026-11-07]**（100 万 token あたり、入力／出力）：Sonnet 5.5 は $2／$10、**1M まで一律で長い prompt の割増の帯は無い**。cache 書込み（5 分）$2.50（1.25×）、**cache 読み $0.10（0.05×。旧台帳の 0.1× を直した）**。Haiku 5.5 は 100K 以下 $0.10／$0.50、100K 超 $0.50／$2.50（cache 読み 0.1×）。
- **日本語の token 数 [確認済：count_tokens]**：1.03〜1.10 token／字（旧仮定 1.25）。Sonnet と Haiku は同値。
- **Sonnet の出力 token（thinking を含む）[実測：72 request]**：中央値 989、平均 988、p90 1,546、最大 2,087。**max_tokens 4,096 に達した切れは 0／72**、空の出力 0。arm 別の平均は 0＝861、A＝1,064、B＝1,103、O＝979、C＝1,002、D＝916（p=30。本測定の cell は入力が大きいので出力の分布が違いうる）。
- **cache [実測]**：cache 読みの割合は、全文 arm（C・D）で 83％・94％、0・O で 77〜80％、A・B は検索の断片と IR が質問ごとに変わるので 32〜52％。C・D の 2 request 目以降は prefix を読んだ（停止規則 6.4 の 9 割以上を満たす）。
- 1 request あたりの費用（p=30、$）：0＝0.010、A＝0.015、B＝0.021、O＝0.011、C＝0.039、D＝0.022。
- 本測定の cell は p=59・117。C・D の prefix は 1 (cell, arm) ごとに書く（1.25×）と、残りの質問が読む（0.05×）。g-ja-1 は p=59／117 で 19／20 問、m-ja-2 は 20／20 問。Haiku の 100K 超の request は 158（C が 79、D が 79。C は prefix が同じなので 1 問目だけ測り、質問ごとに送るので 79 に数える）。

### 6.2 内訳（本測定 79 問×6 arm、Sonnet）

| 項目 | low（出力 989） | central（988） | high（平均の 2 倍） | worst（全件 4,096） |
|---|---|---|---|---|
| Sonnet の本測定 | $12.9 | $12.9 | $17.6 | $27.6 |
| Haiku の反復（0・A・B・O 3 回、C・D 1 回。100K 超は 5 倍の帯） | $3.2 | $3.2 | $3.2 | $3.2 |
| Scene p だけを渡した Haiku（3.5 の label。79 問×1 回） | $0.03 | $0.03 | $0.03 | $0.03 |
| judge（Haiku。回答 1,580 件×$0.0004、自己一致の再判定で 2 倍） | $1.3 | $1.3 | $1.3 | $1.3 |
| 済み（Gold 作成・検証 $15.83、通し・judge・誤答など） | $18.0 | $18.0 | $18.0 | $18.0 |
| **合計の見込み** | **約 $35.4** | **約 $35.4** | **約 $40.1** | **約 $50.1** |

- 中央の見込み **約 $35.4 は上限 $60 に収まる**。全 request が max_tokens に張り付く最悪（$50.1）でも収まる。残り（最悪でも約 $9.9）は予備。
- cache が効かない場合は、C・D の入力が Sonnet で +$61.4、Haiku の C・D でも +$14.7（100K 超の帯の 158 request。reestimate.mjs の式。概算では約 $17）、合計 **約 +$76**（cacheMissExtraUsd）になり上限を超える。**効かなければ止める**（6.4）。Haiku の反復の段（answer-haiku、上限 $4）は、Haiku の cache が効かなければ段の上限で先に止まる。
- Sonnet の照合は subagent（API の費用なし）。誤受理率の測り直しの誤答は人手で作成（API なし）、その judge は済み（約 $0.05）。

### 6.2.1 段の上限の配り直し（ledger.mjs の STAGE_CAPS_USD。合計 $60 の gate は別に掛かる）

| 段 | 上限 | 済み | 用途 |
|---|---|---|---|
| gold | $16 | $15.83 | Gold の作成・補充・検証（済み。旧 $18） |
| context | $1 | $0 | count_tokens（費用 0） |
| answer-sonnet-pass | $3 | $1.42 | Sonnet の小さい通し（ユーザー指示の上限） |
| judge-sonnet-pass | $0.5 | $0.03 | 通しの judge（ユーザー指示の上限） |
| answer-haiku | $4 | $0.25 | Haiku の通しと本測定の反復（見込み $3.2）と、Scene p だけを渡した Haiku の label（見込み $0.03）。段の見込み合計 $3.47 |
| judge-haiku | $4 | $0.37 | judge（通し・誤受理・本測定。見込み $1.3） |
| judge-misaccept-gen | $0.1 | $0.097 | 旧 API の誤答の生成（済み。新しい誤答は API なし） |
| answer-sonnet | $30 | $0 | 本測定の Sonnet（見込み $12.9、最悪 $27.6） |

段の上限の合計は $58.6。

- 台帳の注記：済みの gold 段（$15.83）は、旧台帳が Sonnet の cache 読みを 0.1× で計上していたため、価格表どおり 0.05× で計算した実費より **約 $1.33 多く載っている**（保守側）。履歴なので書き換えない。上限 $60 に対する余裕が約 $1.33 増えるだけで、停止線は変わらない（ledger.mjs の注記）。
- ledger.mjs の価格の注記（旧『cache 読みは 0.1× 一律』）は、Haiku が 0.1×、Sonnet が 0.05× に直した。

### 6.3 凍結前の縮小の規則

v3.1 の規則『外挿した中央値が **$42 を超える**場合は、各 cell を 16 問に縮める』は、上限 $50 のときの値だった。**決定 9：上限 $60 に比例させた $50 を事前登録に書く**（外挿した中央値が $50 を超えるなら各 cell を 16 問に縮める）。中央値は約 $35.4 で、$42 のままでも $50 でも超えないので、縮めない。凍結の後は規模を変えない。

### 6.4 止める規則

- 費用は全 request の usage から累積で計算し、1 cell が終わるごとに残りを外挿する。
- **実行の順（主指標を先に）**：0・A・B・O（全 cell、約 $5）→ C・D を cell の小さい順（g59、m59、g117、m117）。
- 累積が **$48**（上限の 80％）に達したときに残りの外挿が **$60** を超えるなら、残りの C・D の cell を止めて相談する。**累積が $60 に達したら即時停止**（runner の定数。旧 $40／$50 を比例させた）。上限の変更はユーザーの決定。
- 全文 arm の最初の 2 request の後、cache_read_input_tokens が prefix の 9 割未満なら止める。429 が 2 回続いたら並列度を半減し、さらに続けば停止。
- **max_tokens の切れ（決定 8）**：製品と同じ 4,096 のまま。**最低 20 request を見てから、切れが 2％ を超えたら中断して integrator が見直す**（runner の TRUNCATION_MIN_REQUESTS＝20、TRUNCATION_MAX_RATE＝0.02 と一致。通しでは 0％）。**中断の後の判断は逸脱として記録する**。切れた回答は製品の挙動として扱い、得られた本文のまま採点し、arm ごとに数えて報告する。
- API の失敗が連続して 5 件欠測になったら（系統的な不具合）止める。認証失敗（401／403）・台帳の gate・CP-4 の重なりは再送も欠測もせず止める。
- **中断の際に途中の結果を採点しない**：停止規則が働いたら runner は stopped.json を書く。中断した run は、中断の後の判断を deviations.json に逸脱として記録し、その ID を --deviation-id で渡さない限り、judge・summarize・再開に進めない（main-run.mjs。途中までの回答は採点・集計・照合の対象にしない）。
- **別の評価 run との重なりの guard**：key の取り出しと runner の送信の前に、`pgrep -f "[c]p4-"` で CP-4 の run が走っていないことを確かめる（走っていれば止まる。自分の command line に一致しない角かっこの形）。

### 6.5 除外と欠測の規則（事前登録）

- **Sonnet（回答）の API 失敗**：同じ request を最大 3 回まで再送する（初回を含め最大 4 回送る。HTTP 層の 429／5xx の再試行は別で最大 5 回）。なお失敗なら**欠測**として answers-missing.jsonl に残し、他の request は続ける。
- **refusal**（stop_reason が refusal）は**棄権として採点**し、件数を arm ごとに出す。**空の回答は棄権**。どちらも judge を呼ばない（abstained＝true、誤りの flag はすべて false、項目の再現はすべて false）。N 型では正しい棄権になる。
- **切れた回答**（max_tokens）は得られた本文のまま採点し、切れの件数を arm ごとに出す。
- **judge の失敗**（出力が壊れる、API の失敗）は、同じ回答を 3 回目で打ち切り、その回答は**欠測**。集計から黙って落とさず、欠測の件数を arm ごとに出す（haiku-pass-lib.mjs の summarize と analysis-lib.mjs の completeness）。
- **対応のある差で片方の arm が欠測の質問**（回答の欠測、judge の欠測、止めた cell の未送信）は、**その比較から外し**、外した件数を比較ごと・arm ごと・理由別に報告する（pairsPlanned、pairsUsed、excluded）。反復のある arm（Haiku の 0・A・B・O）は、採点できた rep の平均を使い、全 rep が欠測なら欠測。
- 上の規則は main-run.test.mjs（偽の API の応答）で、再送・欠測・refusal・切れ・停止線・台帳の gate・段の上限・中断・除外の件数・bootstrap の再現性が設計どおりに動くことを確かめた。

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

**進捗（凍結稿の時点）**：手順 1〜7 は済み（Gold の人の照合も済み。1/30）。IR は決定 5 で作り直し、Haiku の通し（168 回答）は全件を新しい request で作り直し、Sonnet の通し（72 回答）を行った。誤受理率の測り直しの材料（誤答 60＋陽性対照 20）と照合の材料の生成（verify-materials.mjs）・指示書（v3.2）も済み。**本測定の runner（main-run.mjs、runner.mjs、main-run-lib.mjs）と集計（analysis-lib.mjs。bootstrap・除外・(b) の確定）、凍結の manifest（freeze-manifest.mjs）を実装し、偽の API の応答で試験した（手順 6 の延長）。本測定の API は呼んでいない。残り：8（事前登録の凍結＝manifest の作成・contracts への commit）、9（本測定。Sonnet は 79 問×6 arm の 474 request、Haiku の反復は 1,106 request）、10（採点・照合・較正・集計）**。

v2 の 6〜8 日から、層 2・3 の arm（A_s の synopsis 生成、A′・A″、B_route 系）、別系列 judge、Opus の回答、p=30 を含む 100 問の設計を削って絞った。順序：1〜4 と 5 は並行できる。**Gold 照合の前は 8 に進まない**。

### 7.3 事前登録の凍結の対象と手順

凍結の対象の一覧は manifest（JSON、`<data>/freeze-manifest.json`、0600。`node freeze-manifest.mjs build --design <最終稿>`）に作る。本文は含まず、commit と sha256 と定数だけ。

- **code**：code の commit（dev 枝）と、`haiku-pass-lib.mjs`・`request-body.mjs`・`verify-materials.mjs`・`runner.mjs`・`ledger.mjs`・`overlap-guard.mjs`・`analysis-lib.mjs`（集計）・`main-run-lib.mjs`・`main-run.mjs`（runner の CLI）・`oracle.mjs`・`lib.mjs`・`key-source.mjs`・`freeze-manifest.mjs` の sha256。
- **answer の request**：model・effort・max_tokens（4,096）・thinking・sampling 引数なし・anthropic-beta・定型句の sha256・停止規則の定数（$48／$60、cache 9 割、切れ 2％・最低 20 request、並列度、再送 3 回、欠測の連続 5 件）・台帳の上限。
- **judge**：model（Haiku 5.5）・effort（low）・max_tokens（4,000）・thinking・system block の形・prompt v3 の sha256・**user message の型**の sha256（架空の固定入力で描画）・打ち切りの回数（3）。
- **集計・照合**：bootstrap の種・反復回数・区間、比較の一覧、照合の抽出の種・率（verify-materials.mjs）、主指標の定義。
- **data**：質問（cell ごと）・arm の request の集合（cell ごと）・count-arms・scene-labels・確認済み 30 問・人の照合の結果・誤受理の誤答・照合の指示書の sha256。設計の最終稿の sha256 も入れる。

本測定の `main-run.mjs answer` は、manifest が今の code・設定・data と一致するときだけ始まる（一致しなければ止まる）。凍結の後に code や data を直したら manifest を作り直し、逸脱として記録する。

## 8 保存と records

- 本文を含むものはすべて repo の外：`/home/grimodex/fusion-eval-data/ir-chat-pilot-2026-11/`（権限 0700、ファイルは 0600）。質問・Gold・回答は原稿の事実を含むので repo に入れない。複製 DB、request のダンプ、回答、judge の出力もここ。**製品の保存範囲は変えない**。
- 送信ログに Authorization などのヘッダを書かない。renderer から repo 内へ戻すものは件数と enum に限る。Electron の userData と /tmp の一時物は実行後に消す。
- 保持：完了後 30 日で、ダンプと複製 DB は削除（または圧縮して退避）。質問・Gold・回答は残す。
- **records に入れる**：件数・字数・ID（質問 ID、Scene 番号、event ID）・型・根拠 Scene 数、質問集・Gold 集・回答集の**ファイル全体に 1 つずつの sha256**、arm 別の token・cache・費用・stop reason・並べ順、判定の enum、層別の集計、区間、棄却数、Gold の誤り率、judge の誤受理率、較正の一致率と κ、事前登録の hash。
- **v3.2 で records に足したもの**：judge の prompt の版と hash、IR の選択（製品の経路との重なり・根拠 Scene との重なり・seed の長さ）、断片の並べ順（fragmentOrder）、人の照合の誤り率（1/30 と範囲）、価格表の確認、max_tokens の照合と製品との body の差、通し（Haiku・Sonnet）の summary の hash、誤受理率の summary の hash、照合の抽出の件数（selection-summary。本文なし）。
- **凍結稿で records に足したもの**：Gold の機械検査の n-gram の基準と受理した最大値（goldOverlapThresholds）、除外と欠測の規則（missingAndExclusionRules）、製品の thinking・effort の確認（findings の F19、F20）、凍結の manifest の sha256（integrator が contracts に載せる）。
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
15. token 数は count_tokens の実測（1.03〜1.10 token／字）に置き換えた（旧仮定 1.25）。
16. **B・D の IR は製品の経路と同一ではない**：評価側が質問つきの seed で選ぶ（決定 5）。製品の経路は質問を載せられず、同じ cell の全質問で同じ行になる。両者の 8 件の重なりは平均 4.2／8。質問依存の選択は、製品に無い能力を評価に持ち込んでおり、B−A は『製品が今できること』ではなく『質問から IR を引ければできること』の上限寄りの見積り。根拠 Scene の IR への収まり（46％対 20％）が違う。
17. **judge の限界**：Haiku 5.5 low の judge が、根拠の段落だけ（原稿全体ではない）を見る。unverified は誤りの確定ではない。誤受理の測定の誤答は 1 人（Claude）が書いた定型寄りの文（hedge-list は『〜とも〜とも読め』の形）で、実際の model の誤答より検出しやすい。judge と誤答の作者が同系列。flag ごとの自己一致は、陽性が少ない flag（unverified κ 0.53）で低い。
18. **Sonnet の照合の限界**：盲検化を仕組みで守れない（文体・長さ・相対的な位置表現から arm を推測できる）。Claude Code の system prompt と tool が固定されず、版で変わりうる。judge と同系列。原稿を読み切れずに見落とす誤りが残る。照合は judge の出力の 25％・(b) の候補・N の全件に限る。
19. **盲検化の限界**：位置表記と IR 特有の書式は除くが、相対的な位置表現と、文体・長さの差は除かない（4 節）。
20. **人の照合の範囲**：抜粋が項目を支えるか、質問が曖昧でないか。M・U・K の網羅と後の更新の見落としは見ていない。誤り率 1/30（Wilson 上限 0.167）は、その範囲の値。
21. **max_tokens 4,096 は製品と同じ**で、thinking も数える（決定 8）。通しでは切れ 0／72（出力の最大 2,087）だが、p=59・117 の cell は入力が大きく、出力の分布が違いうる。切れた回答は製品の挙動として得られた本文のまま採点し、arm ごとに数えて報告する。最低 20 request を見てから切れが 2％を超えれば中断し、integrator が見直す（中断の後の判断は逸脱として記録する。6.4）。切れが多い arm では再現率が低めに出る。
22. **誤受理の測定は楽観的に出る**：誤答の作者と judge の prompt の作者が同じ（Claude）で、hedge-list の書き方が v3 の規則の例に寄っている。実際の model の誤答はより紛らわしい。誤受理率 0/20 の上限（Wilson 0.16）は、実際の誤受理率の上限を保証しない。
23. **陽性対照の不足**：陽性対照は正答の言い換えだけで、『正しい項目に別の場面の真の事実が混ざった回答』が無い。judge が参照の段落の外の真の事実を unverified や contradiction にする誤 flag は測っていない（限界 17）。
24. **回答の条件は製品の既定と違う**：製品の chat の effort は getEffortForTask('chat')＝medium で、pilot の Sonnet は high（ユーザー決定）。製品が thinking を送ること自体は確かめた（11.4）。効果の大きさは『製品の既定より思考を多く使う条件』の値として読む。
25. **judge の (b) の候補率・unverified 率は arm 間で比べない**（参照が根拠の段落だけなので C・D・O で高く出る偏り。4 節）。arm 間の誤りの比較は照合者の確定値（下限）で行い、S2 の標本の範囲に限る。

## 11 閉じた問いと、ユーザーへの依頼

### 11.1 v2 の 18 の問いの閉じ方

| v2 の問い | v3 での扱い |
|---|---|
| Q1 送信内容、Q12 別系列、Q13 Opus の回答 | 決定 1（Anthropic だけ、OpenRouter・Opus の回答は使わない） |
| Q2 Gold の新設、Q10 標本確認の時間 | 決定 2（AI 下書き・約 30 問の人の確認）。時間の依頼は済み（1/30。11.2） |
| Q3 arm の拡張 | 決定 3（0 と O を加えた 6 arm）。A_s・A′・A″ は不採用 |
| Q8 規模と位置、Q16 費用の上限 | 決定 4（80 問・$50。作れた Gold は 79 問。v3.2 で決定 6 により $60）。閾値・同値の幅は置かない（integrator の既定） |
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

### 11.2 実行の前にユーザーに頼むこと（決定済み・残りなし）

- Gold の 30 問の照合は済み（1/30）。凍結の前の確認は、integrator の決定で閉じた（0.1 の決定 8〜11）。
  1. **max_tokens**：製品と同じ 4,096。切れは arm ごとに数えて報告し、最低 20 request を見てから 2％を超えたら中断して integrator が見直す（決定 8、6.4）。
  2. **縮小の規則の値**：$50（上限 $60 に比例。決定 9、6.3）。
  3. **Sonnet の照合**：judge の後、採点の段で行う（約 250 件。決定 10、4 節）。盲検化・道具の限界は結果に書く（限界 18）。
  4. **結論の文言**：B・D の IR は質問つきの seed で、B−A は『chat に質問で IR を引く経路をつないだ場合の見積り』（決定 11、1.3、1.5）。

### 11.3 実行の後に頼むこと（任意）

- judge の較正の抜き取り（約 40 項目、約 30 分。4 節）。取れなければ結論を「judge 未較正」に限定する。

### 11.4 確かめたこと・確かめられなかったこと（v3.2）

- [確認済：運用記録] IR の event の抽出の入力に、後の Scene は入っていない。抽出は『1 つの project に読書順で Scene を足し、足した時点で 1 件ずつ抽出』（第 6 版の checkpointConstruction）で、足した時点の project に後の Scene が無い。cut DB の project の outline・題・style_guide・ai_instructions は null か中立のラベルで、後の内容が無い。派生文（event の summary）と後の Scene の 20 字の重なりは決まり文句 10 件（F6）で、由来は event の Scene 位置（≤p）と evidence の quote の逐語で保証した。**[未確認] 抽出時の request の実ダンプで、後の Scene の不在を照合してはいない**。
- [確認済：価格表 2026-11-07] Sonnet 5.5 に 100K 超の単価の帯は無い（1M まで標準価格）。Haiku 5.5 には 100K 超の帯（$0.50／$2.50）がある。
- [確認済：コード] max_tokens の製品の値（2.1）。thinking の display（summarized）。
- [確認済：コード、origin/master a2309b95] **製品は Anthropic の chat に thinking（adaptive）と effort を送る**。レビューの懸念（model 一覧の取得後に mergeDynamicCaps が supportsAdaptiveThinking・supportsEffort を false にして buildThinkingParams が {} を返す）は成り立たない。mergeDynamicCaps は getDynamicModelMeta が値を返すときだけ働くが、動的 caps の registry に載るのは openrouter と ollama だけ（store.ts の DYNAMIC_CAPS_PROVIDERS）で、Anthropic の model 一覧の取得（モデル選択メニュー・設定画面・オンボーディングの loadModels）は一覧を更新するだけで capability に触れない。能力表の ANTHROPIC_GEN5_CAPABILITIES（adaptive＝true、effort＝true）が使われ、Rust の apply_thinking_to_body が thinking＝{type:adaptive, display} と output_config.effort に展開する（評価の body と同じ形）。製品の不具合の疑いは無い。**差**：製品の chat の effort は medium（getEffortForTask('chat')）で、pilot の Sonnet は high（限界 24）。未確認：localStorage の永続 cache は provider 名に依らず復元するので、過去の版が anthropic を登録して保存していた場合だけ復活しうる（現行の登録経路は無い）。records の F19、F20。
- [未確認] **arm A・IR の Electron run がローカル以外に接続しなかったか**。run は Wayland・proxy・D-Bus を除いた環境で、使い捨ての userData に Anthropic の key を入れず、AI には送っていない（record の anthropicCalls＝抽出なし）が、通信の記録（packet・request ログ）は取っていない。Chromium の辞書取得など、アプリ自身の接続は止められない（env proxy で止まらない）。『ローカルだけ』とは言わず、『AI への送信は無し（key なし）。ほかの接続は未確認』と書く。
- [未確認] 製品の chat の `stream:true` と非 stream の応答の token・課金の差（同じと見ているが、製品の stream の実ログとの照合はしていない）。

## 12 CP-4 などとの順序

- 設計と確認は read-only で、他の lane を止めない。CP-4 の正式 run や他の評価 run が走っている間は、評価の worktree と profile に触れない。API は key・org の rate limit・費用を他の run と共有するので、走行の有無（process と API 呼出し）を開始前に確かめる。
- lane の順（DR-IRB-3 → IR query 高速化 → #798 → PUB-G の前提）には割り込まない。#798 の dump-run は手本として読むだけで、その枝が動くまで触れない。
- **走行の guard（v3.2）**：key の取り出し（key-source.mjs）と runner の送信の前に `pgrep -f "[c]p4-"` で CP-4 の run の有無を確かめ、走っていれば止まる。command line に `cp4-` の文字を含む process（別の評価の script 名など）にも一致するので、評価の実行の command には含めない。
- 着手の順：(1) 事前検査と資源の preflight → (2〜4) harness → (5) Gold の生成 → **ユーザーの照合** → (7) Haiku の通し → (8) 凍結 → (9) 本測定 → (10) 採点・記録。凍結までは count_tokens を除き、本測定の API を呼ばない。
