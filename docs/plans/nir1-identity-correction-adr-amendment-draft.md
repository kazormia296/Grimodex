# 作者の同定の訂正を規則として再利用する — ADR 改訂案（draft）

> **2026-11-26 改訂**：M3 を全部完了させる指示（contracts の M3 の確認記録の追記 32。原文はそこに記録。直前に示した M3 の未達の一覧に対する指示）を受け、roadmap の Epic P0-A にある ERM-0〜ERM-3 と Exit criteria 全件を扱う（この範囲は起案者の読み）。推奨・技術判断・未決はユーザー決定と区別する。2026-11-23 までの回答記録は §13 に残し、今回の更新は §15 に記す。

| 項目 | 内容 |
| ---- | ---- |
| draftRef | `nir1-identity-correction-proposal/1` |
| Status | 2026-11-26 改訂の draft。指示（追記 32）を受け、Epic P0-A の ERM-0〜3 と Exit criteria 全件を扱う（起案者の読み）。★1・2・3・6・7 の既回答は §13 に保持し、★5・8 の回答（追記 33）と脅威モデル（版 v3）・新しい保存の回答（追記 34）を反映した。今回変更するのはこの草稿だけ。 |
| 基点 | worktree claude-m3-erm-design（2026-11-26のこのcheckout）。コード事実はこのcheckoutで照合し、file:line / 関数名で参照する。roadmap は追記で行が変わるため節名で参照する。過去の基点は§13の改訂記録に保持。 |
| 由来 | roadmap（`docs/plans/narrative-semantic-core-roadmap.md`）の M3「Epic P0-A」節の「ERM-0: Identity correction contract」。原案（`1b1bedbd3` の版）は「ユーザーの選択（2026-11-10）は『規則の ADR も起こす』」と書いたが、その原文の記録は repo の docs・git log（`git log --all -S`）に見つからない（2026-11-23。会話の記憶にあるかもしれないが、この枝では確かめていない）。ここでは決定として扱わず、起案の依頼の範囲の読みにとどめ、ADR を起こすかは ★1 で伺う |
| 前提 | 作者に長い文書を読ませない。Codex の名前・設定は抽出の文脈として provider に送ってよい（2026-11-05）。ADR 013（AI への開示方針）は、抽出の経路を作者視点の例外とし（`docs/adr/013-ai-disclosure-policy.md:115`）、Codex の hidden と年表の secret は「どの経路でも AI に渡さない」（J2。:282）と確認済みである。ただし :118-126 の漏れの一覧が残る間は、:128 が「主な内容の経路」についての約束に限っている（直すまでの時限つきで、hidden を送らない向きで次の PR で直すのが既定）。本草稿は J2 の「どの経路でも」を目標とし、この時限と両立させる（§9-2） |

用語：**表記**（surface）は本文に出る呼び方（例：肩書き、愛称）。**Entry** は Codex の項目（人物など）。
**規則**は作者が宣言した「この表記はこの Entry」という Source（一次入力）。**Rejection** は review で提案を採らなかった記録。
**Source**＝現在の版を決定的に解決できる一次入力（ADR 005 :143-158）。**immutable**＝書いた版を変えず、新しい版を足す。
**`human-direct`**＝作者の UI から typed writer で直接書く経路（ADR 006）。**OCC**＝版の突き合わせで後勝ちの上書きを防ぐ仕組み。
**Change Feed**＝書込みの記録の流れ。**Freshness／stale**＝入力が変わって提案が古くなったという状態。**fail closed**＝判定できない時は当てずに止める。
**ERM**＝作者の同定の訂正を覚えて以後の抽出に効かせる機能（roadmap の ERM-0〜3）。**Order Oracle**＝語り順・作中時間の前後を判定する部品（ADR 009、未実装）。**ERM-2**＝merge／split の提案の段。**P0-B**＝Structure Health（構造の不整合の一覧）の Epic。
**hidden**＝作者が Codex の項目に付ける「AI に隠す」印（ADR 013 D2）。

## 一枚目：推奨と残る問い

2026-11-26 の作業範囲は M3 の完了に必要な ERM-0〜3 と Exit criteria 全件。以下の「推奨」は設計案で、決定済みのユーザー回答とは区別する。

- ★1 の回答に従い、同定訂正契約の新 ADR を起こす（現時点の次番号 015、merge 時に再確認）。ADR 005 は参照だけを足す案。
- roadmap の ERM-0 に列挙された5種の規則すべてを設計対象に含めるのが起案者の読み。ただし、これはユーザー決定ではない（★4）。
- 規則は版つきの作者宣言として保存し、決定的な native 層で適用する。AI には規則の中身を送らない（★2・★3の回答）。
- 抽出・取込み・検索・関連シーン・chat の文脈・Structure Health に公開前の訂正を適用する。AI を使わず、訂正直後に同じ呼び名の確認待ち提案へ当て直し、適用件数を示す（2026-11-26回答）。
- 場面の訂正は作品全体の訂正の例外として優先し、作成時にその例外であることを表示する（2026-11-26回答）。
- Merge / Split は影響を列挙する Proposal として扱い、参照 ID の対応を ERM 側に記録する案。完全な影響列挙には現行の参照索引に不足がある（§7・§12）。
- schema・復元・Change Feed・保護 writer・profile egress の台帳を揃え、依存順の PR 分割は §14 に置く。

### ★ ユーザーに伺う点（作者の画面で何が起きるか）

> **2026-11-24 追記（DR-M3-29）**：構造抽出の review 画面を作者に出す判断をした（作者の指示。原文は contracts の M3 確認記録の追記 23）が、**出す時期は「後で」で、旗の既定は閉じたまま**（追記 24）。この節の「今は作者に見えない」は、今も事実である。出す前の直し（文言・空のタブ・根拠から場面へ・復元・適用の事前無効化）は入れた。出す時は、適用（Codex への取り込み）は、取り込みの設定が許す作品でだけ通り、既定の作品では閉じている（画面は理由を出して「適用」を使えなくする）。

【2026-11-25 訂正（DR-M3-32）：この旗の既定は、Work Layer の live 表示と同時に「開く」へ変える予定（`"false"`／`"0"` で閉じる。測定の後の P7。ユーザー回答 W13）。この節の「製品の作者には見えない」は、その PR が merge されるまでの記述として読む。】共通の前提：規則を作る入口の画面（構造抽出の review）は、今は開発 build か、旗 `VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW=true` を付けて build したときだけ開く。この旗は Vite の build 時の値で、作者が実行時に設定できるものではない。したがって製品の作者には見えない（`src/features/codex/codexStructureExtractionFlag.ts:1-18`、`src/features/codex/CodexCandidatesReport.tsx:69`・:309・:490）。製品の作者に今見えるのは、候補一覧と Codex の編集画面（別名・除外語）。そこで「訂正を覚える機能」と「その画面を作者に出すこと」は別の確認に分ける（§8）。以下で「作者の画面で起きること」と書くのは、画面が作者に出た後の話。同じ理由で、今の製品 build では、同定の照合（規則を当てる 3 箇所。§5.1）はどれも作者の操作では動かない。

測定計画の区分は当時の記録として残す。2026-11-26 の回答で ★5・★8 は測定を待たずに決まり、M3 の完了は測定の結果を待たない（追記 32 の指示を受けた起案者の読み）。★4 は全5種を設計対象にする起案者の読みで、ユーザー決定ではない。

**★1 ADR を新しく 1 本起こしてよいか**（方針）
- 推奨：A＝新しい ADR（今の空き番号 015）を起こす。B＝ADR 005 の Amendment。
- A を選ぶと作者の画面で起きること：何も変わらない（記録の置き場の話）。規則の約束が独立した ADR になり、ADR 005 には参照が 1 行足されるだけ。
- 選ばない（B）と：規則の約束が ADR 005 の本文（1,234 行）に混ざる。画面は変わらない。ADR の新設は記録の帰結（契約の承認ではない）に従い、ここで伺う。
- 2026-11-23 の回答：「新しい ADR を 1 本起こす（推奨）」を選んだ（→ 回答：推奨どおり A）。記録番号は今の空き 015 で、merge の時に取り直す。ERM を作るかは測定の後のユーザー判断のまま（作る場合の方針への回答）。

**★2 「呼び名 → 人物」の対応を、作品のファイルに新しい記録として残してよいか**（方針。保存範囲の拡大）
- 推奨：A＝新しい表に、版つきで残す。
- A を選ぶと：作者の画面の見た目は変わらないが、作品のファイルに、別名とは別の記録が新しく残る。作品ファイルの構造の版（schema の版）が 1 つ上がる（番号は merge の順で取り直す。§9）。
- 選ばない場合：B＝Codex の項目の列に足す案は、場面ごとの区別・履歴・古くなった提案への知らせに乗せにくく、さらに AI の道具が読む Codex の項目の表（`codex_entries`）に載るため、hidden の人物を指す対応が読める窓になりうる（§9-2。全列を読める扱いかは未確認）。C＝保存しない案は、今ある「別名に足す」（打ち手 1）だけになり、場面で指す人が変わる呼び名・曖昧な呼び名・別名にしたくない呼び名は覚えられない（§6）。
- 2026-11-23 の回答：★2 と★3 をまとめた問いに、「1 で良いと思いますが、3 はサジェストしないんでしょうか？」と答えた。★2 は「1 でよい」＝推奨どおり（→ 回答：推奨どおり A。別名とは別の新しい記録＝新しい表として作品のファイルに残し、作品ファイルの構造の版が 1 つ上がる。番号は merge の順で取り直す）として記録する。「3 はサジェストしないのか」への扱いは ★3 に記す。

**★3 「呼び名 → 人物」の対応そのものを、AI に送らなくてよいか**（方針。送信範囲）
- 推奨：A＝規則の中身（呼び名と人物の対応）は AI に送らない。AI の答えが返った後で、作者の端末の中で当てる。
- A を選ぶと：作者の画面の変化は無い。AI に届く内容は今と同じ形のまま（評価の数値の基になる送信の形も変わらない）。AI は対応を知らないままなので、AI の判断そのものは良くならない。AI が規則と食い違う人物を示した場合は、規則が先に当たり、AI の示した人物は「AI は別の人物を示した」として並べて見せるだけになる（§4）。
- 選ばない（B：規則の表記と人物名を AI に送る抽出の文脈に足す）と：AI の判断に効きうるが、「規則・理由・場面の対応」は新しい種類の送信になり、hidden の人物を指す規則の扱いを別に決める必要がある（ADR 013 の抽出の経路の例外に入るかも決める必要がある）。
- 範囲の注意：A が約束するのは「規則の中身」だけ。人物の名前そのものが AI に届くかは、各機能が hidden を守るかによる。例えば候補一覧の「AI で判定」が、Codex の一覧の先頭 200 件の名前・別名を hidden を除かずに送っている疑いがある（静的な読み、確からしさは medium。`src/features/codex/candidateJudgment.ts:94`、`src/features/codex/CodexCandidatesReport.tsx:148`）。これは ERM とは別の確認で、ADR 013 の漏れの一覧（:118-126）への追記が要る。本草稿の ★ には入れない（§9-2）。
- 2026-11-23 の回答：上の質問を受けて、AI は規則を知らないので規則に沿った提案は AI の側からはせず、AI の答えの後でアプリ側が規則を当てる（AI が別の人物を示したら「AI は別の人物を示した」と並べて見せる）形を説明して再確認し、「AI には送らない（推奨）」を選んだ（→ 回答：推奨どおり A）。AI にも規則を渡して提案させる形（B）は選ばなかった。
- AI の側から規則に沿った提案はしない（AI は規則を知らず、アプリ側が AI の答えの後で規則を当てる）。
- A の理由：「安全側」と「AI に送る内容の形が変わらない」ため。ここでの「安全側」とは、新しい種類の AI への送信を作らず、AI に隠した人物を指す規則の中身が AI へ漏れる窓も作らない、という意味に限る（AI の判断の正しさには寄与しない。上の A のとおり）。ADR 013 の J1（既定は全部開示）とは衝突しない。ADR 013 が守るのは作者の印（hidden）と位置の正しさで、規則は作品知識ではなく作者の宣言なので、送ること自体が禁止されるわけではなく、「新しい種類の送信か」の確認になる。

**★4 最初に覚える訂正の種類**（測定は参考値。数字だけでは決まらない）
- 推奨：A＝「この呼び名はこの人物」の 1 種類だけ。B＝「この 2 人は同じ人ではない」も同時。
- A を選ぶと作者の画面で起きること：訂正は「この呼び名はこの人物」だけ。別人を同じと提案する誤りを抑える操作は出ない。
- B を選ぶと：その操作が出るが、適用先になる「2 項目を同じ人物として統合する提案」の機能が今は無く、現行の抽出が既存の 2 項目の同一視を提案するかも未確認なので、押して効く場面があるかは不明である。
- 2026-11-26 の起案者の読み（ユーザー決定ではない）：roadmap の ERM-0 の5種すべてを設計対象に含める。★4 の「最初の種類」を、M3 完了指示が全5種の設計を求めたものと読む。実装対象を全5種と確定するには作者に確認が要る。

**★5 「この場面だけ」の訂正と「作品全体」の訂正が食い違ったとき**（材料は測定で出る。選ぶのは方針）
- 推奨：A＝場面の訂正を全体の訂正の例外として優先する。
- A を選ぶと：作る時に「作品全体の決めの例外になります」と表示され、その場面では場面の訂正が効く。
- 選ばない（B：両方あれば競合として止める）と：食い違うたびに review に「未解決」が残る。単純だが、同じ肩書きの場面ごとの使い分けのたびに作者が決め直すことになる。
- 区分：測定で材料が出るのは「場面で指す人が変わる表記」の数と、それが提案・候補に出る件数だけ。この表記は名簿を作る AI が見つけたもので、作者の確認は層別の数行だけなので、少ない場合に「見つけていない」のか「少ない」のか区別できない（事前登録 §7.3）。どちらを選ぶかは方針。
- 2026-11-26 の回答：場面の訂正を作品全体の訂正より優先する。作成時に「作品全体の規則に対する、この場面の例外」と作者に表示する。

**★6 訂正を作れるのは作者の画面だけか**（方針）
- 推奨：A＝作者が自分の画面で選んだときだけ作れる。
- A を選ぶと：chat の AI に「この呼び名はこの人物にして」と頼んでも作られない。AI や本文の文面が、作者の知らないうちに対応を作ったり変えたりできない。
- 選ばない（B：chat の AI の操作からも作れる）と：頼むだけで作れて便利だが、AI が規則を書く経路が増え、脅威モデルが変わる。
- 注意：「作者の画面だけ」を検査で固定する方法は今の policy で表現できない（§3）。方法の選択も確認に含まれうる。
- 2026-11-23 の回答：「作者の画面だけ（推奨）」を選んだ（→ 回答：推奨どおり A）。chat の AI からは作れない。「作者の画面からだけ」を今の検査で固定する方法はまだ無く、実装側で呼び出し元を確かめる方向（§3 の決めること (a)）で進める。検査の規則を変える（b）・規則専用の新しい経路を足す（c）場合は、その時に改めて伺う。

**★7 脅威モデルの 4 点（§10）**（方針）
- 推奨：確認まで draft のまま。守りの約束は次の 2 点に要約できる。AI や本文の文面が、作者の知らないうちに訂正を作る・変えることはできない。隠した（hidden）人物を指す訂正の中身は、AI・検索・読者向けの書き出しに出ない（§9-2）。
- 確認すると作者の画面で起きること：画面の変化は無い（守りの約束）。
- 確認しないと：規則の実装に進めない。
- 2026-11-23 の回答：「2 点とも前提としてよい（推奨）」を選んだ（→ 回答：推奨どおり）。(1) AI や本文の文面が、作者の知らないうちに訂正を作る・変えることはできない。(2)「AI に隠す」にした人物を指す訂正の中身は、AI・検索・読者向けの書き出しに出さない（作者の画面にだけ出し、年表の参加者としても保存しない）。**ただし、これは設計の前提の確認で、§10 の脅威モデルの全文の承認ではない。**全文は、作る場合の実装の前に、改めて伺う。
- 2026-11-26 の回答：範囲の広がった全版（規則の全種、統合・分割、当て直し、検索・関連シーン・chat）の脅威モデルを §10 のとおり確認した。受け入れで公開前に必須なのは守りの試験。

**★8 訂正を作った直後の、同じ呼び名の確認待ちの提案**（測定は参考値。数字だけでは決まらない）
- 推奨：A＝同じ呼び名の確認待ちの提案に、AI を使わずその場で規則を当て直し、「ほかに 4 件に当てました［見る］」と件数を見せる。B＝次の抽出から当てる。
- A を選ぶと：訂正した直後に、review 画面の同じ呼び名の確認待ちが減り、件数が出る。当て直しの仕組みと件数の表示を足す（新しい契約になるので、これも伺う）。適用済みの内容は触らない。
- B を選ぶと：訂正した後も、同じ呼び名の確認待ちは残り、次の抽出から効く（打ち手 1 の別名と同じ動き）。
- 区分：参考値は「前の回の確認待ちが同じ呼び名で残る件数」だが、これは抽出の揺れで、作者の繰り返しの負荷ではない（事前登録 §5、§7.3）。
- 2026-11-26 の回答：訂正直後に、同じ呼び名の確認待ち提案へ AI を使わずその場で当て直し、件数を表示する。読み書きは新しい契約として設計する（§3）。

2026-11-23 の★1・2・3・6・7の回答記録は保持し、再確認しない。★5・★8の2026-11-26回答はこの節に追記した。★4の全5種は起案者の解釈（追記 32 の指示の範囲からの読み。作者の回答ではない）。M3完了のための技術設計は、回答済みの範囲内で本草稿に記し、未決を§12に分ける。

## 1. 新しい ADR か、ADR 005 の Amendment か

★1 の2026-11-23回答は、新しい ADR を1本起こすこと。ADR 005 は参照だけを足す案を維持する。理由は、ADR 005 が Scope・Route・Dependency の契約を別 ADR に委ねた前例を持つこと（docs/adr/005-narrative-semantic-core-boundary.md:9-12）、同定訂正が新しい Source・writer・優先順位を定めること、ADR 013 が既存の ADR を置き換えずに開示方針を定めたこと（docs/adr/013-ai-disclosure-policy.md:20-22）。

現時点の docs/adr は ADR 014 までで、次の空き番号は 015。merge 時に再確認する（docs/adr/README.md、一覧確認 2026-11-26）。新 ADR が ADR 013 を置き換えないことを明記する。ADR 005 の Iron Law は変更しない。今回の依頼は草稿1 fileに限るため、実際の ADR はここでは作らない。

## 2. 規則の種類と型

roadmap の Epic P0-A / ERM-0 は5種を列挙する。★4に関する2026-11-26の「起案者の読み」は、5種全部を設計対象にするというものだが、ユーザー決定ではない。型と適用先の案を次に示す。

| 規則 | 型の要点（案） | 適用先（案） |
| --- | --- | --- |
| must-link-surface | 正規化した表記、Entry ID、scope | 抽出・取込み時の表記解決 |
| cannot-link-entries | 同一 project の Entry ID 2件、scope | 同一 entity / merge としての提案を抑止 |
| preferred-binding | 表記と候補 Entry ID、scope | 複数の exact 候補の優先 |
| preferred-canonical-name | canonical name、旧名を alias に残すか | canonical 表示と関連する提案 |
| suppressed-merge-candidate | Entry ID の組、scope | 同じ範囲の merge 候補を再提案しない |

各規則は roadmap の指定どおり author、time、scope、provenance、supersession、reason を持つ。上表は型の意味を整理する推奨で、保存列・UI・全5種の実装をユーザーが決定した記録ではない。

cannot-link-entries は「別の人物だ」と全域に固定する意味にせず、宣言 scope の中で2 Entryを同一 entity として扱わない規則にする案。候補ペアは順序を正規化して同じ組として扱う。場面 scope の ID が言及ごとの場面に届くことは前提にせず、scene ref の対応が未確認なら fail closed にする（§12）。

scene は ADR 009 の any / exact を使う閉じた部分集合にする案。scene scope が作品全体の規則と競合した場合の優先はユーザー決定済みで、場面の規則が優先し、作成時に例外と表示する（★5）。場面 ref が削除済み、Entry が存在しない、別 project を指す場合は規則を当てない。

同じ型の版は上書きせず追記する。全型で共通の履歴欄を持ち、旧版・提案・適用履歴を残す。hidden は保存時に焼き付けず利用時に判定する（§9-2）。

## 3. 保存先と authority

規則は作品ファイル内の新しい immutable revision 表に置く。これは★2の回答済み方針で、保存範囲を広げる判断を再質問しない。新しい authority は作らず、ADR 006 の human-direct と typed native writer を使う案（docs/adr/006-narrative-mutation-authority-routes.md:53-65、policies/narrative/semantic-core-authorities.json:17-22）。AI や本文は規則を作成・変更しない（★6の回答）。

現行 human-direct route は human-ui / manual-wrapper / typed-domain-api を許し、change-feed-writers の検査は route の allowlist と一致させる（policies/narrative/mutation-authority-routes.json:24、scripts/quality/validate-semantic-core-boundary.mjs:1253-1260）。規則 writer では作者 UI 由来の呼出しを検証する必要がある。route・authority・品質規則を新設または変更するなら、現行委任の外なので作者に確認する。★6の回答は、実装側の検証で進める方向であり、その方法自体は未確定のまま残す。

### 3.1 規則の読み書きと即時当て直し

★8の2026-11-26回答を満たすには、既存の API に依存せず、新しい read/write 契約が要る。推奨する形は次のとおり。

- read は project・正規化 surface・scope を入力とし、その表記と一致する未適用・確認待ちの proposal revision だけを列挙する。範囲を明示した結果と、当て直し対象数を返す。
- write は rule revision ID と読み取り時の proposal revision ID を受け取り、各 proposal に訂正を deterministic に適用する。AI を呼ばず、元の model output と review history を残し、新しい proposal revision を記録する。OCC / stale を再確認し、適用済み Domain Data は変更しない。
- 1回の結果に、更新件数と未更新理由の件数を返す。部分失敗を成功件数に混ぜない。読取りと書込みは typed native writer の境界を通す。

これは新しい契約である。既存の提案 revision の再計画がどの writer で安全に実現できるかは【未確認】（proposal の revision を作る現行経路を実装前に照合する）。

### 3.2 Merge / Split と ID の対応

Codex の通常の同一性は同じ Codex ID だけ（M4 の担当の 2026-11-26 の回答。ユーザーの回答ではない）。merge / split 後の対応表は ERM 側で持つ案とし、ID 対応を M2-D1 の同一性定義にはしない。

推奨する ERM-owned lineage 記録は operation ID、operation revision、source Entry ID、target Entry ID、merge/split の向き、scope、provenance を保持する。merge は退役した ID から survivor ID への対応を記録する。split は1つの source ID から複数 target ID への lineage を記録するが、その関係だけでは各既存参照の行先は決まらない。参照ごとの割当てを author が選ぶか、参照型ごとの deterministic policy を別途定める必要がある。自動で一つに割り当てない。

影響表示が Phase / State / Chronicle の実体変更に及ぶ場合は、M2-D2〜D4 の同一性契約が必要になる見込み（未決）。M2-D1〜D4 の identity を ERM で代用しない。

### 3.3 Freshness と writer registry

規則変更は Change Feed に記録し、author-correction dependency で依存する提案を stale にする案（policies/narrative/narrative-dependency-role-registry.json:76-77, 215-226）。即時当て直しも同じ change lineage に記録する。依存辺の伝播だけで merge / split を実行しない（roadmap Epic P0-A / ERM-2）。

新しい表・writer は change-feed-writers.json、protected-writers.json と src-tauri/crates/grimodex-db/src/protected_writers.rs の registry に登録する。snapshot restore は project_snapshots.rs の SnapshotRestoreTable、AuxSpec、restore_links::park / restore の対象に追加し、必要な park 列を定める。profile egress は profile_egress_policy.rs の PROFILE_EGRESS_TABLES に明示分類する。規則表は AI への egress を避けるため closed を推奨するが、profile backup に含める範囲は未決。

## 4. 優先順位と競合

ユーザーが決定した優先順位は一つ：同じ surface に場面規則と作品全体規則があるとき、場面規則を例外として優先する。作成時には「作品全体の規則に対する、この場面の例外」と表示する（★5、2026-11-26）。

それ以外の優先順位は未決。次は推奨案であってユーザー決定ではない。

1. scope が言及に一致する規則を列挙し、場面 exact を作品全体 any より先に評価する。
2. 同じ優先度で矛盾する規則があれば、どちらも勝者にせず unresolved とする。
3. compatible な規則を deterministic に適用し、AI の出力・confidence・fuzzy ranking はその後の情報として review に残す。model output は消さない。
4. exact-name / exact-alias と規則が異なる Entry を示した場合は競合として fail closed にする案。規則を黙って優先させない。

競合として扱うケース（表示先は review と Structure Health）：
- 同じ surface・重なる scope の must-link / preferred-binding が異なる Entry を指す。
- must-link / preferred-binding の対象が cannot-link-entries の禁止ペアに当たる。
- merge Proposal が active な cannot-link または同じ scope の suppressed-merge-candidate に反する。
- 異なる active な preferred-canonical-name が同じ対象を異なる名前に固定する。
- target Entry が消失、別 project、または lineage が曖昧である。

推奨する回復は、作者が競合規則を明示的に retire / supersede し、新しい revision を作ること。明示的な author merge が cannot-link に反する場合も、規則を先に retire してから提案し直す。既存 Rejection は1つの proposal revision / source basis / scope の却下であり、恒久規則に自動昇格しない（ADR 005:581-604）。

## 5. 適用の箇所と順序

### 5.1 `matchExistingEntity` の呼び出しは 3 箇所

`src` の `matchExistingEntity` の呼び出し（test を除く）は次の 3 箇所（`grep` で確認。`electron/`・Rust の別経路は見ていない）。

| 箇所 | 位置 | 渡すもの | 今の状態（旗が閉じた製品 build を基準に） |
| ---- | ---- | -------- | ---------------- |
| AI 経路 | `src/application/narrative-extraction/aiTasks/runEntityResolutionTask.ts:188-193` | `[canonicalName, ...surfaces]` と `explicitIdentityRefs` | `src` に test 以外の呼び手が無い。旗を開いても動かない。`src/features/codex/codexStructureExtractionApi.ts:1739-1741` は `request.useAi` が立っても何もしない「将来の配線」の stub |
| AI なしの seed 経路 | `src/features/codex/codexStructureExtractionApi.ts:1667` | `[seed.surface]`（seed ごと） | 今の構造抽出の本線（旗を開いた build で動く）。ただし呼び手は `startCodexStructureExtraction`（:1514）→ `src/features/codex/CodexStructureExtractDialog.tsx:199` だけで、このダイアログは `structureReviewEnabled`（旗）のときだけ描かれる（`CodexCandidatesReport.tsx:309`）。**旗が閉じた今の製品 build では、作者の操作で動かない**。`explicitIdentityRefs` は無い |
| cluster の `candidateExistingRefs` | `src/features/codex/extraction/entityClustering.ts:244` | 束ねた言及の表記 | `clusterEntityMentions`（:98）に test 以外の呼び手が無い。旗を開いても動かない |

起案時の §4・§5 は AI 経路の `explicitIdentityRefs` の優先順位だけで書いていた。旗を開いた build で実際に動くのは seed 経路だけで、旗が閉じた今の製品 build では 3 箇所のどれも作者の操作で動かない（静的な読み。実行では未確認。旗の値は Vite の build 時の値で、作者が環境変数で開けるものではない）。したがって、以下の「規則が効く」「自動で通る」は、旗を開いた build の話である。規則は 3 箇所のどれにも効く必要があるので、**matcher の前段（3 箇所の手前、または `matchExistingEntity` の入口）で 1 回当てる**形になる。

### 5.2 適用順・対応の方針

各経路で規則を model に送らず、作者が宣言した完全一致の対応を native / deterministic 層で適用する。抽出では model output を保持したうえで confidence / fuzzy ranking の前に規則を解決する（roadmap ERM-1）。複数言及が異なる scene scope に解決する場合は、一つの束に強制せず未解決で review に出す案。

### 5.3 適用箇所

| 経路 | 訂正を使う位置（案） | 必須の条件 |
| --- | --- | --- |
| Codex 抽出 | matchExistingEntity の候補照合前 | scope、Entry の project 所属、規則競合を再検証。既存の3 call site は §5.1 |
| 取込み | Import の proposal / apply 前 | 訂正後も元の import data と出所を保持し、apply 前に scope・OCC を再確認 |
| Semantic Search | query と hit を Entry ID に結ぶ決定的層 | query text 自体を規則記録として AI に渡さない |
| Related Scenes | scene / Entry の関係集計前 | 位置つき言及索引がないため、未索引を完全な impact と数えない |
| Chat Context | context pack の Entry 選択後、provider 送信前 | hidden 判定を通し、規則の値・理由・provenance は request に含めない |
| Structure Health | rule conflict、dangling target、参照先の欠落検査 | 原因と適用 scope を作者に表示し、AI tool には読ませない |

Rule revision の変更後、同じ surface の未適用・確認待ち proposal を直ちに当て直す。対象と件数を read/write 契約の応答に含める（§3.1）。適用済みデータは当て直さない。

### 5.4 ERM-2 の影響表示

Proposal の前に roadmap の全対象を列挙する：Codex Detail / Relation、Phase / State、Chronicle / Timeline、Plot Thread / Foreshadow、Map references、Mention indexes / editor highlights、Search / retrieval / packed contexts。各領域で対象 ID・件数・変更内容・対応不能を示す。未知または未索引の範囲はゼロ件と表示せず「未解決」とし、完全な影響表示ができない状態で apply しない案。

現状、plot_threads と plot_thread_scene_links は thread / scene ID を持つが Codex ID の直接参照はない（migrate.rs の plot_threads / plot_thread_scene_links 定義）。本文の scene_codex_mentions は scene / codex_entry / source / role 単位で、文字位置は持たない（migrate.rs:1598-1606）。従って direct Plot Thread impact と本文中の位置別 impact は列挙できない。間接の scene link / prose は別の影響として表示し、位置の完全性は索引追加後の受入れとする。

決定的 Core は同一性を推測しない。rule は正規化後の完全一致で適用し、部分一致や敬称除去で拡張しない。Assertion の assertionId / M2 identity は変更しない（ADR 005:392-410）。

## 6. 別名で足りる範囲と、規則が要る範囲

2026-11-26改訂では、ここに記した初期の一種類案を、§2の5種を設計対象とする起案者の読みで更新する。以下の6.1・6.2は従来の打ち手と残課題の記録として読む。

別名（`codex_entries.aliases`、除外は `excluded_aliases`。作者の UI は `src/features/codex/components/AliasesField.tsx`・`AliasesChip.tsx`・`ExcludedAliasesField.tsx`）で足りるのは、次の 3 つがそろうとき。
- 作品全体で 1 人だけを指す。
- 正の対応だけ（「この表記はこの人」）。
- 由来・履歴・場面の区別が要らない。

### 6.1 打ち手 1〜4 の merge 後の現状（2026-11-23）

別名に関わる 4 つの打ち手が master に入っている（`git log` で確認）。**ただし、打ち手 1・2 の効く場所（構造抽出の review。`CodexEntityProposalReview.tsx`・`codexStructureExtractionApi.ts`・`codexStructureExtractionStore.ts` から使われる）と、構造抽出での打ち手 4・3 の効きは旗の裏（§5.1）にある。以下の「次の抽出から自動で」は、旗を開いた build の話で、旗が閉じた今の製品 build の作者の操作では起きない**（打ち手 4 の `relationalTerms.ts` は候補一覧の `CodexCandidatesReport.tsx` からも使われ、却下の覚えも候補一覧の画面は製品に出るが、どこまで製品で効くかはこの草稿では確かめていない）。

| 打ち手 | PR | 実現したこと |
| ------ | -- | ------------ |
| 4 関係の呼び名を結ばない | #894 | 続柄・二人称・三人称の呼び名は、別名にも結び先にもしない（`src/features/codex/extraction/relationalTerms.ts`）。役職の呼称と一人称は一覧に入れていない |
| 2 完全一致の結び付けを一括承認 | #899 | 名簿の人物に完全一致する結び付けを一括承認に入れ、実行時と Apply の前に確かめ直す（`entityBulkSafety.ts`） |
| 1 結び先の表記を別名に残す | #903 | review で結び先を選んだ敬称つきの表記を、確認つきで結び先の別名に残す（`src/features/codex/extraction/surfaceAlias.ts`）。足せるのは「敬称を外すと結び先の名前・別名に当たる表記」だけで、呼び名・短い表記・別 Entry との衝突・除外語は足せない。次の抽出から完全一致で自動に結ばれ、一括承認で通る |
| 3 却下を覚えて畳む | #906 | 候補一覧で却下した表記を、名簿に当たらなければ構造抽出でも提案にせず、畳んだことを見せて外せる（Rejection の覚え。規則ではない。§4） |

### 6.2 規則が要る範囲に何が残るか

- 残る：場面で指す人が変わる表記／exact-alias の曖昧さ／別名にしたくない表記／cannot-link-entries が扱う Entry 間の同一化。既存 excluded_aliases は表記の除外であり、Entry ID のペアを禁止する規則とは別である。
- 測定ゲートの旧記述（2026-11-23時点）：作品全体で1人だけを指す敬称つき表記は、打ち手1・2で規則なしに次の抽出から自動で通る（旗を開いた build の話）。負荷を測り直す案も当時の記録として残すが、2026-11-26 の指示（追記 32）の後は、測定は完了の停止条件ではないと読む（起案者の読み）。
- 旧草稿の Chronicle 参加者表記の解決案は、2026-11-26に指定された ERM-1 の対象一覧には含めない。Chronicle / Timeline は ERM-2 の影響表示では対象とする。

## 7. 履歴と取り消し（ERM-3）

- 規則 revision、適用履歴、merge / split Proposal と commit は immutable lineage を残す。訂正を retire する場合も新しい前進 revision とし、過去の review history を書き換えない（roadmap ERM-3）。
- 抽出を再実行した review には、影響した rule ID / revision と、適用した scope を示す。元の model output は別に保持する（roadmap ERM-1 / ERM-3）。
- merge / split は必ず Proposal または明示的な authoring operation とし、Change Feed dependency の伝播だけでは実行しない（roadmap ERM-2）。
- 現行 Codex typed mutation dispatcher agent_codex_mutate_internal（codex_writes.rs:1601-1663）には merge / split 操作がない。新しい canonical typed writer が必要。Codex ID を参照する複数領域を同じ atomic commit に束ねる案。
- narrative_extraction_undo_commit（narrative_extraction/undo.rs:60-64）は commit journal の entities を preflight し、逆順に戻す（同:141-190）。従って複数 entity を含む narrative commit の Undo は可能。ただし、新しい merge / split writer がその lineage を正しく作ることは別の受入れ条件。
- reference ID から全 affected rows を列挙する共通機構は見つからず、Codex 参照は domain tables に分散している（migrate.rs の scene_codex_mentions、foreshadow_codex_links、event_participants、map_node_positions 等）。全参照を特定できない場合、完全な undo を約束できない。適用前に網羅性を確立し、未知の参照があれば止める案。
- split は source ID から複数 target ID へ lineage を記録するだけでは既存参照の振分けにならない。参照型ごとの選択を Proposal に含め、未割当て参照を orphan にしない。各参照の割当てを人が決めるかは未決。

## 8. 作者の操作の最小形

> 2026-11-24（DR-M3-29）と2026-11-25（DR-M3-32）の UI / flag 状況は以前の状態記録として保持する。2026-11-26時点の画面状態はこの草稿では再確認していない。

推奨する作者向け操作：
- Codex review で表記を Entry に結ぶとき、作品全体かこの場面かを選ぶ。作品全体の規則がある表記に場面規則を作る場合、「作品全体の規則に対する、この場面の例外」と作成前に表示する。規則を作らない選択も残す。
- 訂正を保存した直後、同じ表記の確認待ち提案だけに AI を使わず当て直し、対象件数と結果を表示する。適用済み Domain Data は変更しない。
- cannot-link は2 Entry を同一 entity とする提案を止める操作として表示する。merge / split は別の Proposal を開き、変更前に影響一覧と未解決領域を見せる。
- 一覧では規則の scope、Entry、状態、provenance、適用履歴を確認し、撤回は新 revision として行う。hidden の規則も作者には表示する。
- 作者に内部型名を主 UI の文言として見せない。

## 9. schema と送信の変更

SCHEMA_VERSION は現行46（src-tauri/crates/grimodex-core/src/lib.rs:3）。新しい規則 revision / identity lineage 表を足す場合は次の migration 番号を merge 順で決め、既存の version pin（workspace_schema.rs:798、release_schema_migration.rs:179 等）も合わせる。現時点での「47」は予約しない。

表を加える際に必要な変更は次のとおり：project snapshot restore の table inventory と park 対象、change-feed-writers.json の feed writer、protected-writers.json と native protected writer registry、profile_egress_policy.rs の明示分類。上記の具体的な正本は project_snapshots.rs::SnapshotRestoreTable / AuxSpec / restore_links::park、policies/narrative/change-feed-writers.json、policies/narrative/protected-writers.json、profile_egress_policy.rs::PROFILE_EGRESS_TABLES。復元時の park 列と参照復元の意味を規則 revision / lineage に合わせて定義する。

推奨する最小保存単位：
- correction rule の immutable revision と supersession / retirement lineage。
- merge / split の operation revision と Entry ID 対応（§3.2）。
- proposal revision が参照した rule revision と、直後の当て直しの結果。
正確な表数・列・snapshot 形式は ADR 草稿で決める。profile egress は規則の中身を汎用読取・AI request に出さないよう closed 分類を推奨するが、作者 backup に含めるかは別途確認する。

### ★3 A（規則の中身をAIに送らない）の設計条件

★3の2026-11-23回答は規則をAIに送らないこと。全経路で次を守る。
1. 規則の値、reason、scope と Entry 対応は AI request / tool results / packed context に含めない。決定的な層が model output の後でローカル適用する。
2. 新しい規則表を Main read allowlist、standalone MCP、renderer AI tools に公開しない。
3. 検索・Related Scenes・Chat Context が規則で解決した Entry を文脈候補にする場合も、送信直前に ADR 013 の hidden 判定を通す。
4. hidden の Entry は作者向け画面には表示できるが、hidden 状態を規則 revision に固定しない。phase / scene に応じ既存判定で再評価する（codexHiddenFromAi.ts::resolveCodexForAi / visibleCodexForAi）。
5. reader-facing export に規則や hidden target の名前を新たに含めない。
6. event / audit に規則の表記・Entry 対応を入れる必要性と AI 向け読み経路は【未確認】。Change Feed の freshness に必要な最小 ID と、AI egress 内容は別に分類する。**§10 の守り（隠した人物に関わる理由の文・件数・ログも出さない）を満たすための、実装の前の必須の確認。この経路を照合して形を決めるまで、規則・対応表の書き込みと、AI に渡る経路への適用は入れない。**

## 10. 脅威モデル（2026-11-26 に作者が確認。版 v3）

確認の記録：contracts の M3 の確認記録（原文は handoff の `m3-user-answers-20261126b.md`）。以下の引用は、伺った問いの文面そのもの。

**信頼する相手**（回答：この内容で確認（推奨））

> 【訂正を覚える機能の脅威モデル 1/4】訂正の規則を作る・変える、項目を統合・分割できるのは、作者の画面の操作だけにします。本体側で「作者の画面から来た」と確かめられる仕組みができるまで、書き込みは開けません。AI の出力（chat の道具を含む）、本文や取り込むファイル内の指示、画面が申告する値、背景の保守、外部の MCP クライアントは信頼せず、規則の作成や統合を実行できません（AI は提案を出すだけ）。確かめる仕組みが新しい経路になる場合は、改めて伺います。

**守る対象と、守らないもの**（回答：この内容で確認（推奨））

> 【脅威モデル 2/4】守る：AI や本文の指示で知らないうちに規則や統合が行われること、「AI に隠す」の人物の情報が出ること、矛盾する規則で勝手に勝者が決まること、消えた項目や別の作品の規則が当たること、取り込みで規則が持ち込まれること、統合・分割で参照が壊れて戻せなくなること。守らない：同じパソコンでファイルを直接書き換えられる人と、作者自身が誤った規則や統合を作ること（取り消せるようにします）。

**必ず入れる守り**（回答：この内容で確認（推奨））

> 【脅威モデル 3/4】(1) 前回ご確認のとおり、「AI に隠す」人物を指す訂正の中身は AI・検索・読者向けの書き出しに出しません（作者の画面にだけ出し、年表の参加者としても保存しない）。今回は統合・分割の結果、理由の文、件数、ログにも広げ、使う時点の場面の状態で判定します。(2) 規則の中身は AI に送らず、版を残して書き換えません。(3) 食い違いは勝手に選ばず確認待ちに出します（場面の訂正を優先する場合を除く）。(4) 統合・分割は影響を見せてまとめて行い、取り消せます。取り消しや当て直しは、後の他の変更を戻さず、適用済みや承認した提案に触りません。

**隠した人物を含む統合**（回答：その場で選ぶ）

> 【統合】「AI に隠す」の人物と、隠していない人物を 1 つにまとめるとき、まとめた後の項目をどうしますか？

> - 選択肢「AI に隠す側にする（推奨）」：漏れない安全な扱いです。隠していなかった人物も、統合の後は AI から見えなくなります。統合の前にそのことを表示します。
> - 選択肢「その場で選ぶ」：統合の前に「隠す」「見せる」を選ぶ画面を出します。見せるを選ぶと、隠していた人物の情報も AI に見えるようになります。

【起案者の読み】作者がその場で「見せる」を選んだ項目は、それ以後は「AI に隠す」の人物ではないとして扱う（守りの (1) は、隠している項目に掛かる）。

**受け入れへの影響**（伺った文面への回答は「いいけど別にそこまでガチガチでなくても良い」。続けて問い直した結果：守りの試験だけ必須（推奨））

> 【脅威モデル 4/4】上の守りを試験で確かめるまで公開しません。評価の基準は変えず、訂正を使う評価は別の条件として記録します。検索や chat の挙動が変わるので、公開前の評価の取り直しの対象に入れます。AI への開示の方針にもともとある漏れは、この作業では広げません（直すのは別の作業です）。

> 「そこまでガチガチでなくても良い」の反映です。公開の前に必須にするのは、どこまでにしますか？（どれを選んでも、評価の基準の値は変えません。公開全体の評価の取り決めは別です。）

> - 選択肢「守りの試験だけ必須（推奨）」：隠した人物が出ない、作者の操作だけが書ける、などの試験は必須。訂正を使う評価の別記録や取り直しは、M3 としては必須にしません。
> - 選択肢「試験も最低限」：必須は「隠した人物が AI や書き出しに出ない」と「知らないうちに書き換わらない」の試験だけにし、他は後で足してもよいことにします。
> - 選択肢「元の案のまま」：すべての守りの試験、別の評価記録、評価の取り直しを必須にします。

したがって、公開の前に必須なのは守りの試験。問い 4 の文面のうち、訂正を使う評価の別記録と評価の取り直しは、M3 としては必須にしない。評価の基準の値は変えない。公開全体の評価の取り決めは別（統合者の記録では、検索・関連シーン・chat への適用は最後の凍結と正式 run の差分の一覧に入る）。

**新しい保存**（回答：足す（推奨））

> 【保存】作品のファイルに次の記録を足します（ファイルの構造の版が 1 つ上がります）：訂正の規則の版の履歴、統合・分割の履歴と項目の対応表、提案がどの訂正を使ったかと当て直しの結果。作者のバックアップと復元にも含めます。よろしいですか？

## 11. 受入れ条件の案（roadmap の Exit criteria との対応）

| roadmap Epic P0-A Exit criteria | この草稿で求める受入れ |
| --- | --- |
| 訂正した結び付けが、次の抽出で作者に聞かずに再利用される | 同一 scope の次の抽出と取込みで再利用し、別 scope には漏れない。model output と適用 rule revision を両方確認できる |
| cannot-link が同じ誤った merge の提案を防ぐ | 同じ Entry pair / equivalent scope の再実行で merge / same-entity Proposal を出さず、scope 外では一律抑止しない |
| 矛盾する規則が fail closed し、Structure Health に出る | winner を推測せず unresolved とし、rule revision・対象・scope・理由を Structure Health に出す |
| Merge / Split の影響 preview と取り消しが dependent data を orphan しない | roadmap の全影響群について対象と件数を出し、未解決参照は隠さず apply を止める。single atomic typed-writer commit を Undo し、参照・lineage・dependent data を復元する |

現行に位置付き mention index と共通 Codex-ID reverse lookup がないため、Mentions / editor highlights まで完全な preview ができるまでは4行目の達成としない。Codex ID だけでは split 後の参照先を一意に選べないケースは、人の選択と履歴が残ること。評価閾値・Gold の変更はこの草稿では決めない。

## 12. 未確認の点と限界

### 12.1 2026-11-26 に照合した事実

- roadmap の対象は docs/plans/narrative-semantic-core-roadmap.md の Epic P0-A / ERM-0〜3 / Exit criteria。
- merge / split 専用の Codex writer はない。codex_writes.rs::agent_codex_mutate_internal の dispatch（1601-1663）は relation / phase / detail / tag / type の操作を列挙する。
- Plot Thread の schema は plot_threads と plot_thread_scene_links に thread / scene ID を持つが Codex ID を持たない（migrate.rs:2355-2408）。直接の Codex reference は確認できない。
- scene_codex_mentions は scene_id / codex_entry_id / source / role を持ち、本文内の位置を持たない（migrate.rs:1598-1606）。BodyMentionIndexState は scene revision と matcher hash の走査状態で、位置別 mention index ではない（src/features/codex/bodyMentionIndexState.ts::recordBodyMentionScans）。
- Codex ID から全 affected references を共通 API で列挙する仕組みは確認できていない。参照は scene_codex_mentions、foreshadow_codex_links、event_participants、map_node_positions などに分散する（migrate.rs:1332-1403、1586-1606、2521-2526）。これは確認した現行構成の記述で、別の未読経路があれば更新する。
- narrative_extraction_undo_commit は commit journal の entities を preflight し逆順に戻すため、複数 entity を含む commit を扱える（narrative_extraction/undo.rs::narrative_extraction_undo_commit、mutate_commit:141-190）。
- schema は46（grimodex-core/src/lib.rs:3）。この checkout の docs/adr は014までで、次番号の候補は015。
- 表の変更が snapshot restore / park、Change Feed、protected writer、profile egress の各 registry に届く根拠は §3・§9 記載の実装入口。

### 12.2 作者に確認が要る点・未確認

- ★4：5 種すべて作る（追記 32 の指示の範囲からの起案者の読み。作者の回答ではない）。
- Split で複数 target に分かれる既存参照を、参照型ごとに作者が割り当てるか、別の制約を設けるか。
- Impact preview が Phase / State / Chronicle の実体変更に進む場合、M2-D2〜D4 identity をどの PR で確定するか（見込み）。
- 「公開前」の境界が、作者の apply / commit、読者向け export、または外部公開のどれを指すか。
- profile egress の closed 分類。規則・lineage 表を作者の backup と復元に含めることは 2026-11-26 に確認した（§10 の新しい保存）。
- scene scope を observation / proposal の sourceRef から scene ID に確実に対応づける契約。現行型は sourceRef を文字列で保持するだけである（evidence/types.ts:11-16、source/sourceView.ts）。
- 同一表記 proposal の安全な再計画 read/write 経路と、部分失敗時の結果表現。
- Import と Semantic Search の各 canonical entry point、Related Scenes と Chat Context の packed-context 境界、隠しEntryの既存判定が全対象 call path に届くこと。
- writer で作者UI由来 caller をどう検証するか。新 authority / route / policy 変更が要るなら委任外。
- text mention index をどう実現して impact を完全化するか。現在の scene_codex_mentions は位置を持たず、Plot Thread に直接 Codex link はない。
- author-correction producer registry、snapshot restore の park mapping、profile egress table class の列の全変更位置と生成物は【未確認】。実装 PR 前に policy validator / generated schema を追う。
- ADR 015 を他の同時作業が予約していないか（未保存の別セッションは見えない）。

### 12.3 限界

同じ場面の同じ表記を複数人物に同時に結ぶ場合の扱い、曖昧な split の参照割当て、位置付き言及索引が整う前の完全な影響列挙は、この草稿で確定していない。規則を適用できない範囲を「影響なし」と見なさず、fail closed とする案。

## 13. 2026-11-23 の改訂の記録

M3 の前倒し（上の決定①〜⑤）に合わせた改訂。構造と節番号は保った（hidden の節は §9-2、6 条件は §9 の中に足した）。

変えた点：
- Status・基点・前提：2026-11-23 の決定 5 点と、「測ってから伺う」の更新（★1・2・3・6・7 は測定と並行で先に伺う。★5 の材料だけが測定で出る）を反映。基点を `b7f8fa336` に。前提に ADR 013 を足した。
- 一枚目：★1〜★8 を、作者の画面で起きること（選ぶと／選ばないと）に書き直し、測定で決まる部分と方針を分けた（★5 の材料だけが測定。★4・★8 は参考値。★1・2・3・6・7 は方針）。作者向けの例は肩書き・愛称などの一般語にした。入口の画面が今は作者に見えないことを共通の前提に置いた。
- §1：ADR 013（AI 開示方針）・014（場面の情報）が使用済みのため、新 ADR の仮の番号を 015 に（merge の時に取り直す）。README の「012 まで」を改め、番号の確かめ方を記した。新しい ADR も ADR 013 を置き換えないと明記。
- §3：writer ごとに allowedCallers を `human-ui` だけに絞る案が今の検査で表現できないことを訂正し、決めること (a)〜(c) を並べた（§10・§11・★6 も追随）。schema の版を 46（定義の場所つき）に、版の直列と merge の順の取り直しを記した（HSR/1 は未確認）。producer 宣言が無い点、保護 writer の一覧の場所を記した。
- §4・§5：`matchExistingEntity` の呼び出し 3 箇所を確かめて表にし、旗を開いた build で動くのは seed 経路だけ（`src` の grep）で、旗が閉じた今の製品 build では 3 箇所のどれも作者の操作で動かないこと（追補 1 で限定を足した）、`explicitIdentityRefs` の順序は AI 経路の配線後の話であることを明記。規則は matcher の手前に当てる必要があること、打ち手 2・4・1 との前後を「決めること」に。表の行 4 の理由を ADR 013 の「残るもの 1」へ。
- §6：打ち手 1〜4（#894・#899・#903・#906）の実現状況と、規則が要る範囲に残るものを書いた。
- ★3 の理由を「安全側」「AI に送る内容の形が変わらない」に直し、約束の範囲を「規則の中身」に限った。hidden を指す規則は ADR 013 の J2（目標は「どの経路でも」。:128 が漏れの一覧の間は「主な内容の経路」に限る）に合わせた（追補 2 で、初版の言い換えが J2 より弱かったのを直した）。★3 A が成り立つ 6 条件を §9 に。
- §9-2（新）：hidden を指す規則の扱い 7 点（焼き付けない・allowlist に足さない・v1 は表示だけで年表の参加者として保存しない・読者向けのエクスポートから除く・作者の画面には出す・使う箇所は既存の判定を通す・確認文の約束の範囲）。
- §8：入口の画面が今は作者に見えないことを明記し、規則を作ることと画面を出すことを別の確認に分けた。
- §12：確かめ方を 3 つ（読み直した行・持ち越した行・未確認）に分けた。起案時の未確認のうち、schema の版・`CodexEntityResolutionPicker` が review の画面であること・observation の `sourceRef` の有無は確かめた。
- 行番号・参照：`CodexEntityProposalReview.tsx:288`→:518、`existingEntityMatcher.ts:140`→:146 ほか、`runEntityResolutionTask.ts`・`codexEntityHypothesis.ts`・`proposalPlanner.ts` の位置を直した。`change-feed-writers.json:1829` の参照は誤りだったので削った。

### 追補：独立レビュー（2026-11-23）の反映

結論を伏せた read-only の照合の指摘を、根拠の行を確かめ直してから反映した。
1. 旗の裏の限定：今の製品 build では、`matchExistingEntity` の 3 箇所のどれも作者の操作で動かない（seed 経路の呼び手は `CodexStructureExtractDialog.tsx:199` だけで、そのダイアログは `structureReviewEnabled` のときだけ描かれる）。一枚目・§5.1・§6・§11 に「旗の裏」の限定を足し、旗は Vite の build 時の値で作者が実行時に設定できるものではない、と直した。
2. ADR 013 J2：J2（:282）は「どの経路でも」。:128 の「主な内容の経路」は漏れの一覧が残る間の時限つきの限定である。前提・§9-2 の冒頭・§9-2 の 7 を、この関係で書き直した。
3. roadmap は行番号をやめ、節の名前で参照した。
4. 「作ると決まった場合の設計案」を冒頭と一枚目に置き、§2・§3・§5.3・§11 の断定を案の書き方にした。producer registry への宣言の追加は policy の契約を足すことなので、確認の対象と明記した。
5. 由来の行：2026-11-10 の「規則の ADR も起こす」の原文は repo に記録が見つからず、決定として扱わない（ADR を起こすかは ★1）。
6. 小さな点：決定の根拠を記録の帰結に（Status）／決定②の語を記録の言葉に／前提として示された区分を回答と区別／`lib.rs` の :9・:10／版を固定する試験 4 か所／行のずれは「file の増分」と「位置のずれ」の区別／role の語彙の置き場の追加／旗の file は 18 行／観測の `evidence` の位置／規則が先に当たる★3 の記述／「安全側」の定義／「表示だけ」は保存の範囲の話／作者向けの★から内部の語を外した／方針の問いは 1 回にまとめて伺う、に直した／§4 と §5.2 の別名との優先の食い違いを解消。

### 追補：★1・2・3・6・7 の回答の記録（2026-11-23）

- ユーザーが 2026-11-23 に構造化質問で回答した内容を、決めたことを超えない形で記録した（一枚目の各 ★ の「2026-11-23 の回答」、§3 の決めること (a)〜(c) の末尾）。「推奨」の文は書き換えず、回答の事実を足した。回答は作る場合の方針で、ERM を作るかは測定の後のユーザー判断のまま。★7 は設計の前提の確認で、§10 の脅威モデルの全文は未承認のため、草稿の Status は `[precheck]` の draft のまま。★4・★5・★8 は未回答（測定の後）。判断の記録は `docs/plans/nir1-lane-decisions/m3-decisions.md` の DR-M3-11。

未確認の点：§12.2 のとおり。特に、HSR/1 が schema の版を上げるか、`sourceRef` が場面を指すか、writer 側での呼び出し元の検証方法、`change_events` の payload、他セッションの ADR 番号の予約、候補一覧の AI 判定が hidden を除かないことの実行での確認。

この草稿に判断表（どの数字で ERM を作る／作らないか）は書かない。それは事前登録側（`docs/plans/nir1-fusion-records/identity-review-load-2026-11/preregistration-v1-draft.md`）の話で、測る前に固定する。


## 14. PR 分割と依存順（案）

1. **PR 0 — ADR 015 と受入れ契約**：この草稿を作者確認の後にADR化し、ERM-0〜3とExit criteria、競合・scope・hidden・Undoの境界を記録する。ADR番号は作成時に再採番する。
2. **PR 1 — schema / rule / lineage 基盤**：immutable rule revision、merge / split ID lineage、typed native read/write、Change Feed、restore park、protected writer、profile egress を一つの版上げとして揃える。
3. **PR 2 — Merge / Split Proposal と影響表示・Undo**：PR 1 の lineage を使い、全参照領域の enumeration、atomic typed writer、multi-entity Undo を実装する。split の未割当参照を扱えるまで apply を開かない。
4. **PR 3 — 抽出・取込みと即時当て直し**：PR 1 の規則 read/write を使い、抽出 / import の決定箇所、確認待ち proposal への非AI当て直し、件数応答を実装する。
5. **PR 4 — Search / Related Scenes / Chat Context**：PR 1 の規則と lineage を使い、各 retrieval path で適用する。provider 送信前に ADR 013 hidden を確認し、規則の中身を送らない。
6. **PR 5 — Structure Health と受入れ閉鎖**：conflict / dangling / unindexed reference を診断し、§11 の四条件と roadmap の Exit criteria を閉じる。

PR 2・PR 3・PR 4 は PR 1 の後に独立して始められる。PR 5 は各検出面が揃った後。M2-D2〜D4 が必要になる箇所は、適用前に契約依存として順序を確定する。

## 15. 2026-11-26 改訂の記録

- M3 を全部完了させる指示（追記 32）を受け、roadmap Epic P0-A の ERM-0〜ERM-3 と Exit criteria 全件を本稿の対象にした（範囲は起案者の読み）。2026-11-23時点の「作るかは測定後」という記録は経緯として§13に残し、現行スコープの根拠にはしない。
- ★5：場面 scope が作品全体 scope より優先し、作成時に例外と表示する。★8：同じ surface の確認待ち proposal に直後・非AIで当て直し、件数を表示する。read/write は新しい契約になると記した。
- ★4：ERM-0 の5種すべてを対象に含めるのは起案者の読みで、ユーザー決定ではないと明記した。
- M4 担当回答を反映：M2-D1 identity は同一 Codex ID のみ。merge / split の ID 対応は ERM が保持する。影響が Phase / State / Chronicle の ID に及べば M2-D2〜D4 が要る見込みとした。
- Merge / Split writer、逆引き参照、Plot Thread の直接 Codex ref、位置付き mention index、複数 entity の narrative Undo を現行コードで照合し、根拠を§5・§7・§12に記した。
- SCHEMA_VERSION 46 と ADR 015 候補を確認した。新表に必要な restore park / Change Feed / protected writer / profile egress の登録先を記した。
- ★1・2・3・6・7 の2026-11-23の回答経緯と§13の記録は保持した。§10には指定の1行だけを先頭に追加し、脅威モデル本文と★7の記述は変更していない。
- 今回変更した file は本草稿だけ。コード、schema、policy、他の docs は変更していない。
