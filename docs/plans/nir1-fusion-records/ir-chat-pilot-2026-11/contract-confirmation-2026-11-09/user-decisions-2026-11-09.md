# chat の IR：ユーザーの回答（2026-11-09、AskUserQuestion）

質問票：`../questions-2026-11-09/db-conn-and-chat-ir.md`。回答は選択肢のラベルの逐語。実装と経路の開放は PUB-G の後（変わらず）。

| 項目 | 回答（逐語） | 備考 |
|---|---|---|
| (a) 年表の `search_events` の「今の Scene より後を除く」filter | 「Scene に結ばれた event にだけ掛ける (推奨)」 | Scene に結ばれていない event は今のまま返す。既存の tool の結果が変わる＝AI 挙動資産（品質ゲートの対象）。実装の前に決める細部：複数の Scene に結ばれた event をいちばん前の Scene で見るか後ろで見るか、今の Scene が無いときの扱い。 |
| (c) tool の結果の、local の会話の履歴への保存 | **訂正後：「本文は残さない。tool 名・query・件数と使った ID だけ (推奨)」** | 最初の回答は「quote と要約を残す」だったが、同日のユーザーの発言「tool 結果の保存はやっぱり推奨で」で推奨に変更した（最初の回答は撤回）。承認済みの保存範囲（使った IR の ID と、作者の訂正・却下）の内に収まり、保存範囲の拡大には当たらない（質問票の整理）。 |

## (c) の後続（実装の前に扱う）

- 履歴に残すのは tool 名・query・件数と、使った ID（と作者の訂正・却下）だけ。`resultSummary` は件数のみにする。
- その結果：次の turn で model は前の tool の結果を見られない（必要なら再度呼ぶ）。履歴の再描画で出典の引用は出せない（ID から引き直す）。IR が誤っていたときの影響は履歴に残らない。
- 確かめて固定する（S1 の項目）：audit の記録・tool cache・debug log に結果の本文が残らないこと、次の turn で `tool_result` が再送されないこと（質問票ではコード上の読みで、試験では未確認）。
- 質問票の「入れなかった要確認事項」（chat の agent を Chronicle IR の Consumer にする新しい契約と新しい IPC の threat model、閉じた経路の開放 S3 と PUB-G の順）は、まだ未確認（★）。

## 質問せずに進める（統合者の技術判断）

- (b) held-out の作品：m-ja-1 を使えるか、IR の件数と score の分布を read-only で先に確かめる。疎すぎる・分布が違いすぎるなら新しい作品の抽出（作品の本文を外部 API へ送るので、費用の見積りと送信先・権利の確認を取る）。

## (b) held-out の確認結果（統合者。2026-11-09 夜。read-only）

詳細は `m-ja-1-heldout-check.md`。

- **既存の m-ja-1 の IR は held-out に使えない**: 承認済み event は 161 件（1.46 件/Scene。g-ja-1 は 7.56、m-ja-2 は 4.71）、event を持つ Scene は 45%（g-ja-1 91%、m-ja-2 96%）。本測定の probe では m-ja-1 は 0 件の query が 34%、上限 8 件に届くのは 1.2%（m-ja-2 は 82%）で、弱い hit を捨てる線 τ の検証に使える母数が足りない。疎さの原因は、位置 89〜110 の 22 Scene が未試行、試みた 88 位置のうち 33 が失敗、prompt も古いこと。
- **m-ja-1 に Gold が無い**（pilot の Gold は g-ja-1 と m-ja-2 だけ）。
- **現行の抽出で取り直せば「条件つきで使える」**: 作品 1 つぶん約 $8〜12（再試行込みで $15 以内。pilot の spend.json からの逆算）、抽出に約 2 時間。送信先は既存の評価と同じ Anthropic で、『こころ』は公有なので新しい送信先ではない。ただし model の記憶が回答の再現に混ざりうる（推測）。代案は、AI 原稿の新作（記憶の交絡がなく権利の確認も不要）、m-ja-3（青年、公有、IR 未抽出）。
- **朝にユーザーへ**: held-out の作品（m-ja-1 の取り直し／AI 原稿の新作／m-ja-3）と費用の確認。実装と経路の開放は PUB-G の後なので急がない。
- 確認できなかった点: m-ja-1 の query と IR の cosine の分位（model の実行が要る）、疎さの寄与の分解、vector 58 件が未登録の理由。

## ★ 2 点：ユーザーの回答（2026-11-09 朝、AskUserQuestion。回答は選択肢のラベルの逐語）

| 項目 | 回答（逐語） | 帰結 |
|---|---|---|
| ★ 新しい契約と IPC の脅威モデル／経路の開放の順 | 「起案を進め、承認は draft の後に個別。開放は PUB-G の後 (推奨)」 | chat の agent を Chronicle IR の Consumer にする契約と新しい IPC の脅威モデルの draft を read-only で起案する。**承認はその draft を読んでから個別に取る**（今回の回答は起案の許可で、承認ではない）。経路の開放（S3）は PUB-G の後。 |
| held-out の作品 | 「今は決めない」 | m-ja-1 の取り直し／AI 原稿の新作／m-ja-3 のどれも選ばない。Gold の決着（正式 run の後）に改めて聞く。費用（m-ja-1 は約 $8〜12）の確認も、そのときに取る。 |

## ★1〜★4：draft を見たユーザーの回答（2026-11-09 朝。draft＝`consumer-contract-threat-model-draft.md`。回答は選択肢のラベルの逐語）

| 項目 | 回答（逐語） | 帰結 |
|---|---|---|
| ★3 audit に IR の本文が残る件（決定 (c) との食い違い） | 「audit で IR の本文を置き換える (推奨)」 | audit の `request.prepared` では、IR 由来の tool 結果を revision ID・出典 Scene の ID と題・score・索引の generation・送った文字列の digest に置き換える。**audit の「送った body をそのまま記録する」契約の変更**（`captureState`、`effectiveRequestReceipt`）を含み、renderer → IPC → N-API → Rust の各層に置き換えの印を運ぶ変更が要る。**条件（実装前に確かめ、崩れたら改めて聞く）**：照合が成り立つこと（tool 結果の文字列化が決定的か、quote の正本が revision に入っているか）、T16（renderer が置き換えを悪用して別の本文を audit から隠す）の防御＝Native が自分で発行した結果と完全一致する部分だけ置き換える、を入れられること。`get_scene` の本文は今のまま audit に残る。 |
| ★4 外部へ送るデータの範囲 | 「承認の文言どおり要約と quote に限る (推奨)」 | 性質の field は送らず、research sub-agent には IR を返さない（△10 の (a)）。開放（PUB-G の後）の前に、作者向けの開示の文言を足すかを改めて聞く。 |
| ★1 契約 | 「§3 のとおり承認する (推奨)」 | `search_events` を拡張して IR も引けるようにする形（`chat-agent-ir-read`）。新しい Freshness・承認・開示の authority と永続の chat 側の写しは作らない。細部（△）は別に確認。**S1 の最初の mutation は★2〜★4 の回答が済んだので、この点では止まらない**（実装は PUB-G の後。DB 段 1 より後）。 |
| ★2 脅威モデル | 「draft のとおり確認する。前提は S1 の前に実物で確かめる (推奨)」 | 乗っ取られた renderer と、model が `get_scene` で後の Scene を読むことは範囲外。**前提「unrestricted の `related_scenes_begin` が製品の既定の起動で IR の解釈を返せる」は S1 の前に実物で確かめる（S1-17）。崩れたら乗っ取られた renderer を範囲内にする案へ切り替えて改めて聞く。** |

未確認のまま（draft §6）：audit の body に本文が入ることは試験していない（コードの読みのみ。統合者も `lib.rs:6080-6150` で `request.body` が丸ごと書かれることは確認）、Native の索引 cache が結果を持つか、Chronicle の索引の query が別 process の worker を使うか、Electron の製品に送信データの区分ごとの同意があるか、`codex-app-server` で agent の tool が使われるか。
memory の「own-data-read の開放は止める」（da1-webrtc-egress-precheck）は古く、DR-DA1-35 で開放済み（`profileEgress.ts:48`）— memory を直す材料。

## △6・△7・△8：ユーザーの回答（2026-11-09 朝。逐語）

| 項目 | 回答（逐語） | 帰結 |
|---|---|---|
| △6 L8（dispatch 直前の再検証）との食い違い | 「受け入れて記録する (推奨)」 | chat の IR は L8 の Packing ではなく別の契約として扱い、L8 との関係を記録する。one-shot（tool 実行後〜次の送信の間に承認が撤回されても再検証しない。窓は 1 turn の中）。agent の loop の汎用層に IR の知識を持ち込まない。 |
| △7 年表の filter の細部 | 「一番前の Scene で見る。今の Scene が無ければ年表は filter しない (推奨)」 | 結ばれた Scene のうち最も前のものが今の Scene 以前なら返す（決定 (a) の「全部が前」の文字どおりの読みとは違う読みを、ユーザーが選択）。今の Scene が無いときは年表に位置の filter を掛けず、IR は 0 件。「IR の規則で除かれた revision の eventId は年表からも除く」（draft §3.4 (4)）。既存の tool の結果が変わる（AI 挙動資産）ので、品質ゲートと秘匿仕様の文書の改訂を伴う。 |
| △8 「今の Scene」の定義 | 「Scene の scope ならその Scene、それ以外は turn 開始時の activeSceneId (推奨)」 | どの場合も turn の開始時に捕まえる（T3）。 |

**質問せず技術判断で進める（draft の推奨どおり。確認不要の技術判断）**：△5 新しい command は restricted で拒否の区分（`plaintext-publication`）に置く。△9 renderer からの直接呼び出しは agent の capability に結ばない（★2 の前提が崩れて範囲内にする場合だけ再検討）。△10 research sub-agent には IR を返さない（★4 と整合）。△11 turn ごとの IR の字数の累積上限を置く（値は held-out の後に τ と一緒に決める＝閾値の値）。

## 追記：2026-11-16 JST の決定（AskUserQuestion）

- 質問：chat IR の実装は「PUB-G の後、DB 段 1 より後」と決めていた。技術的に PUB-G に依るのは、製品で開ける S3 だけ。S0〜S2 の順序を変えるか。
- 回答：**「S0 は今、S1・S2 は S4 の merge 後 (Recommended)」**
- 読み：
  - S0 は今進める。読むだけで、API は使わない。
  - S1 は、次の S4（9 回目）の PR を merge した後に始める。定数は false のまま実装する。
  - S2（閾値の実 AI 試験）は S1 の後に行う。CP-4 の正式 run とは重ねない。
  - S3（開ける）は、今までどおり PUB-G の後。ユーザーに個別に確認する。
