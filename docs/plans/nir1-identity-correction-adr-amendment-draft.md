# 作者の同定の訂正を規則として再利用する — ADR 改訂案（draft）

> **作ると決まった場合の設計案。作るかは測定の後のユーザー判断（決定③）で、まだ決まっていない。**以下の「v1 は〜にする」「足す」「入れる」「満たす」はすべて案の書き方で、決まったことではない。

| 項目 | 内容 |
| ---- | ---- |
| draftRef | `nir1-identity-correction-proposal/1` |
| Status | `[precheck]` の draft。**ユーザーの確認まで実装しない。**★1・★2・★3・★6・★7 は 2026-11-23 に構造化質問で回答済み（各 ★ の「2026-11-23 の回答」に記した。回答は**作る場合の方針**で、ERM の実装の承認ではない。ERM を作るか自体は、同定の review の負荷の測定の後のユーザー判断のまま。★7 は設計の前提の確認で、§10 の脅威モデルの全文の承認ではなく、全文は作る場合の実装の前に改めて伺う）。★4・★5・★8 は未回答（測定の後）。草稿の Status は `[precheck]` の draft のまま。既存の ADR・policy・コードは変えていない。**2026-11-23 の改訂（§13）**：ユーザーの決定は次の 5 点（記録の正本は contracts 枝の `docs/plans/nir1-pubg-records/user-confirmation-2026-11-23-m3-pullforward.md`、commit `71e45bb4`。この枝にファイルは無く、`git show 71e45bb4` の本文と照合した）。①範囲は LSB ロードマップの M3（Living Codex Core）まで、M4 は範囲外。②M3 の技術判断（作り方・PR の分け方・試験）は、NIR-1 の残りの lane と同じ範囲で委任。③ERM は先に測る（同定の review の負荷を先に測ってから伺う、という 11-11 の決定のまま）。作るかは測定の後のユーザー判断。④方針の問い（★1・2・3・6・7）は測定と並行で先に伺う（古くなった起案を直してから、作者から見える場面の形で 1 回にまとめて伺う）。⑤凍結の後でも M3 の製品の変更は master に merge してよい。**2026-11-11 の「測ってから伺う」（★8 つを測定の結果と一緒に伺う）のうち、方針の ★1・2・3・6・7 は、④で測定を待たずに伺うことになった。**なお、測定で材料が出るのは ★5 だけで、★4・★8 は参考値、★1・2・3・6・7 は数字では決まらない、という区分（事前登録 §7.3）は、記録の上では回答ではなく、2 回目の問いで「前提として示したこと」である。記録の帰結は、これは方向の決定で、ERM の契約（★1〜★8）・保存範囲・脅威モデルの承認ではなく、起案の後に個別に伺う、としている。したがって、新しい契約・保存範囲の拡大・AI への新しい送信・ADR の新設・脅威モデルは、委任の外として確認する（根拠は記録の帰結。AGENTS.md の「委任に含まれないもの」は、新しい契約・authority、保存範囲の拡大、データの新しい送信先などを挙げる）。以下の「推奨」はどれも決定ではない（回答の事実は「推奨」を書き換えず、各 ★ に「2026-11-23 の回答」として足した）。2026-11-11 に確かめた点の現在位置：`CodexEntityResolutionPicker` は同定の review の画面で使われる（`src/features/codex/CodexEntityProposalReview.tsx:518`）／`candidateKey` は前後の空白の除去・NFC・英大文字の小文字化だけで、全角と半角・かなの揺れは吸収しない（`src/features/codex/codexCandidates.ts:25-30`）／観測は根拠として `sourceRef` を持つ（`src/features/narrative-extraction/ir/observations/entityIdentity.ts:44-47` の `ObservationBase.evidence` が `RawEvidenceReference[]`、その型は `src/features/narrative-extraction/evidence/types.ts:11-16`） |
| 基点 | 今回の改訂：worktree `claude-m3-docs`（枝 `claude/m3-docs-roadmap-erm0`、origin/master `b7f8fa336`）。コードの行番号は §13 で記した範囲を `b7f8fa336` で確かめ直したもの。roadmap は、同じ PR が追記して行がずれるので、節の名前で参照する（行番号を書く場合は「基点 `b7f8fa336` で」と付ける）。起案時：worktree `unruffled-shamir-d6147f`（master `2caf67a6`、今の head の祖先であることを確認）。確かめ方は §12 |
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

推奨（要点。**ERM を作ると決まった場合の案**。いずれも決定ではなく、作るかは測定の後のユーザー判断＝決定③）
- 新しい ADR（番号は今の空き 015。merge の時に取り直す）「Identity Correction Rule Contract」として起こす案。ADR 005 には参照の 1 行だけ足す（§1）。ADR を起こすか自体は ★1 で伺う。
- 最初は `must-link-surface`（表記 → Entry）の 1 種だけにする案。scope は「作品全体」か「この場面だけ」の 2 択（§2）。
- 規則は作者の宣言の Source として新しい表に immutable な版で保存し、`human-direct` の経路から書く案。保存範囲の拡大なので ★2 で伺う。ただし呼び出し元を作者の UI だけに絞る方法は今の検査で表現できず、決めることが残る（§3）。
- 規則は model の出力より先に決定的に適用し、矛盾したら勝者を選ばず「未解決」に戻して見せる案。既存の別名との前後は決めること（§4、§5.2 の 4）。適用の位置は matcher の手前で、呼び出しは 3 箇所ある（§4、§5）。**この 3 箇所は、今の製品 build では、どれも作者の操作で動かない（旗の裏。§5.1）**。
- 規則の中身は AI に送らない。model の出力の後で native／決定的な層が当てる（§5、★3）。人物の名前そのものが AI に届くかは、規則と別に各機能が hidden を守るかによる（§9-2）。
- 入口は、作者が review で人物を選んだ直後の 1 行の問い「次からも『（その表記）』→（その人物）にする？［この場面だけ］［全体］［しない］」。ただし review の画面は今は作者に見えない（§8）。

### ★ ユーザーに伺う点（作者の画面で何が起きるか）

共通の前提：規則を作る入口の画面（構造抽出の review）は、今は開発 build か、旗 `VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW=true` を付けて build したときだけ開く。この旗は Vite の build 時の値で、作者が実行時に設定できるものではない。したがって製品の作者には見えない（`src/features/codex/codexStructureExtractionFlag.ts:1-18`、`src/features/codex/CodexCandidatesReport.tsx:69`・:309・:490）。製品の作者に今見えるのは、候補一覧と Codex の編集画面（別名・除外語）。そこで「訂正を覚える機能」と「その画面を作者に出すこと」は別の確認に分ける（§8）。以下で「作者の画面で起きること」と書くのは、画面が作者に出た後の話。同じ理由で、今の製品 build では、同定の照合（規則を当てる 3 箇所。§5.1）はどれも作者の操作では動かない。

決め方の区分（`docs/plans/nir1-fusion-records/identity-review-load-2026-11/preregistration-v1-draft.md` の冒頭と §7.3）：**測定の数字で材料が出るのは ★5 だけ（それも「一部」）。★4・★8 は測定の数字が参考値で、数字だけでは決まらない。★1・2・3・6・7 は方針で、測定では決まらない。**どの数字でどの選択肢に決まるかは事前登録側の話で、本草稿には書かない。

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
- 回答：未回答（測定の後）。

**★5 「この場面だけ」の訂正と「作品全体」の訂正が食い違ったとき**（材料は測定で出る。選ぶのは方針）
- 推奨：A＝場面の訂正を全体の訂正の例外として優先する。
- A を選ぶと：作る時に「作品全体の決めの例外になります」と表示され、その場面では場面の訂正が効く。
- 選ばない（B：両方あれば競合として止める）と：食い違うたびに review に「未解決」が残る。単純だが、同じ肩書きの場面ごとの使い分けのたびに作者が決め直すことになる。
- 区分：測定で材料が出るのは「場面で指す人が変わる表記」の数と、それが提案・候補に出る件数だけ。この表記は名簿を作る AI が見つけたもので、作者の確認は層別の数行だけなので、少ない場合に「見つけていない」のか「少ない」のか区別できない（事前登録 §7.3）。どちらを選ぶかは方針。
- 回答：未回答（測定の後）。

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

**★8 訂正を作った直後の、同じ呼び名の確認待ちの提案**（測定は参考値。数字だけでは決まらない）
- 推奨：A＝同じ呼び名の確認待ちの提案に、AI を使わずその場で規則を当て直し、「ほかに 4 件に当てました［見る］」と件数を見せる。B＝次の抽出から当てる。
- A を選ぶと：訂正した直後に、review 画面の同じ呼び名の確認待ちが減り、件数が出る。当て直しの仕組みと件数の表示を足す（新しい契約になるので、これも伺う）。適用済みの内容は触らない。
- B を選ぶと：訂正した後も、同じ呼び名の確認待ちは残り、次の抽出から効く（打ち手 1 の別名と同じ動き）。
- 区分：参考値は「前の回の確認待ちが同じ呼び名で残る件数」だが、これは抽出の揺れで、作者の繰り返しの負荷ではない（事前登録 §5、§7.3）。
- 回答：未回答（測定の後）。

伺い方（作者に長い文書を読ませない）：決定記録（`71e45bb4`）の 2 回目の回答のとおり、方針の問い（★1・2・3・6・7）は、作者から見える場面の形で **1 回にまとめて**伺う。1 回の中の並べ方は、★2・★3・★6 を「review で肩書き・愛称をある人物に結んだ直後の 1 行の問い」とその保存・送信の約束として、★1（ADR を 1 本起こす）は 1 行で、★7 は守りの約束 2 点の確認として。★5 は測定の材料が出た後、★4・★8 は測定の参考値と並べて後で。入口の画面を製品の作者に出すか（§8）は、記録の問いの範囲外なので、同じ 1 回に添えるか別にするかは未確認。

## 1. 新しい ADR か、ADR 005 の Amendment か

推奨は新しい ADR（★1）。理由は 3 つ。
- ADR 005 は Scope・Route・Dependency を別 ADR に正本として委ねる前例を持つ（`docs/adr/005-narrative-semantic-core-boundary.md:9-12`。006・009・010 を指す）。規則も同じ形にできる。
- 規則は 005 の Deferred decisions（:1018-1033）のどれにも当たらない新しい Source の種類・writer・優先順位で、005 の本文（1,234 行）に足すと境界の本文と混ざる。
- ADR 013（AI への開示方針）が、ADR 002 の「AI に隠すための仕組み」という位置づけだけを改め（013:20）、ADR 009・010・011 を「置き換えない」とした書き方の前例がある（013:22）。新しい ADR も ADR 013 を置き換えないと明記する。

番号：今の `docs/adr/` は 001〜014（004 は本体と checklist の 2 file）。**013＝AI への開示方針、014＝場面の情報をエディタに統合**で、起案時の「新 ADR 013」は使用済み。`docs/adr/README.md` の表も 014 まで。今の空きは **015**（仮）。確かめ方は ADR 013 の Status（013:16）と同じで、local・remote・tag の全 ref の `docs/adr/` を `git ls-tree` で調べ、015 以上を持つものは 0 件だった（2026-11-23。他のセッションの未保存分は見えない）。HSR/1・SRD/1・AWA/1 などが ADR を起こす可能性は見えないので、**番号は merge の時に取り直す**。README に番号の付け方の規則は無く、表の連番に従う。

ADR 005 側の変更は、Status の正本の一覧に「同定の訂正規則は ADR 015（仮）」を 1 行足すだけにする。Iron Law（:848-873）は変えない。規則は Iron Law 1「本文と明示的な作者宣言を一次 Source とする」（:850）の「作者宣言」に当たる。新しい ADR の Status には、ADR 013 と同じく「ユーザー確認なしの委任（AGENTS.md の NIR-1 の残レーン）の外」と注記し、M3 の前倒しの委任（上の決定②、記録は `71e45bb4`）が及ぶ範囲を書く。ADR の新設は、記録の帰結（契約の承認ではない）に従い、★1 で伺う。

## 2. 規則の種類と型

roadmap の ERM-0 の 5 種のうち、v1 は `must-link-surface` だけにする案（★4）。
- `preferred-binding`（複数の候補から 1 つを優先）は、曖昧な表記に `must-link-surface` を置けば同じ結果になるので、型を増やさない。
- `preferred-canonical-name` は Codex の名前と別名の編集（既存の作者の編集）で足りる。
- `cannot-link-entries`・`suppressed-merge-candidate` は merge の提案（ERM-2。roadmap の「ERM-2: Merge / Split proposals」）が適用先になる。現行の抽出が既存の 2 Entry の同一視を提案するかは未確認。

型の案（v1。確定は ★2・★7 の後）。
```ts
interface IdentityCorrectionRuleRevision {
  ruleId: string;            // 規則の安定 id
  revision: number;          // 版。上書きせず版を足す
  kind: "must-link-surface";
  surfaceKey: string;        // 正規化後の完全一致キー（candidateKey と同じ正規化）
  surfaceDisplay: string;    // 作者が見た表記
  entryId: string;           // Codex Entry の id
  scope: { scene: { kind: "any" } | { kind: "exact"; ref: string } }; // ADR 009 の scene 軸の部分集合
  state: "active" | "retired";
  supersedesRevision: number | null;
  author: "human"; createdAt: string; reason: string | null; // reason は任意の短文
  provenance: { fromProposalRevisionId?: string; fromReviewDecisionId?: string };
}
```
roadmap の ERM-0 の「Each rule records author, time, scope, provenance, supersession, and reason」の 6 つをすべて持つ。**規則には hidden の状態を持たせない**（§9-2。Phase で変わるため、焼き付けない）。

**場面ごとに変わる規則**（同じ肩書きが場面で別人）は `scope.scene = exact` の規則を場面ごとに置いて表す。
- ADR 009 の Scope V2 の scene 軸（`docs/adr/009-narrative-scope-relation-contract.md:146-187`）から `any` と `exact` だけを借りる閉じた部分集合にする。`unresolved` と他の軸は持たない。
- ADR 009 §1（:115-132）は「Scope は出所でなく適用範囲」とし、意味が Scene 局所のときだけ `scene = exact` を許す。「この場面のその肩書きはある人物」は意味が場面局所なので、この条件に合う。
- ADR 009 §4（:214-282）の軸の profile は Assertion 種別ごとなので、規則用の閉じた profile（scene は any／exact、他の軸は any 固定）は新しい ADR が定義する。
- 場面は言及ごとに、その言及の根拠の文書から取る。cluster は複数の言及の observation を持つ（`src/features/narrative-extraction/ir/inferences/codexEntityHypothesis.ts:79` の `EntityClusterManifestEntry.mentionObservationIds`）。各 observation は根拠の `sourceRef` を持つ（`src/features/narrative-extraction/evidence/types.ts:11-16`）。**`sourceRef`（型は `NarrativeSourceView["ref"]`、`src/features/narrative-extraction/source/sourceView.ts` で `ref: string`）が場面そのものを指すかは未確認**。1 つの cluster や提案の中で言及ごとの結果が割れたら、その表記は未解決に戻して見せる。場面の ref が消えた規則は当てない（fail closed）。cluster を作る段で場面の規則により束を分けるかは後の設計。
- ADR 009 の比較器・Order Oracle は `declared` で本番の入口が無い（:11-15、:27-29）。v1 は「言及の場面 = ref か、規則が any か」の一致だけを使い、009 の比較器に依存しない。
- 「第 3 章以降は別人」のような範囲は `readingOrder` の interval が要り、Order Oracle を待つ。v1 は場面ごとの規則を UI でまとめて作ることで代える（限界）。
- 同じ場面に同じ表記で 2 人がいる場合（例：同じ肩書きの 2 人）は表せない。その場面の表記は未解決のまま review に残す（限界）。

## 3. 保存先と authority

- 規則は roadmap の Epic P0-A「Product promise」の節の「explicit, versioned author declaration Source」として、新しい表に immutable な版で保存する案（★2。保存範囲の拡大なので確認が要る）。
  `policies/narrative/narrative-ir-contract.json:43,50` の `modality-author-declaration`／`author-declaration` は IR の Assertion の語彙で、`assertionKinds` は `scene-event@1` だけ（:35）。規則は IR の Assertion ではないので、この語彙は流用しない。
- authority は新設しない。`policies/narrative/semantic-core-authorities.json:17-22` の concern `domain-state`（canonical authority は「typed native writer」、`typed-writer-only`）に乗せる。Feature-private な authority は作らない（ADR 005 :1032-1033）。
- 書込みの経路は ADR 006 の `human-direct`（`docs/adr/006-narrative-mutation-authority-routes.md:53-65`、`policies/narrative/mutation-authority-routes.json:24` の allowedCallers は `human-ui`・`manual-wrapper`・`typed-domain-api`）。typed writer・actor context・OCC・canonical Change Event・Change Feed を通る。
  `attention-typed-writer` は Change Feed を出さない（006:139-143）ので Freshness に乗らず、使わない。
- **訂正（2026-11-23）：writer ごとに allowedCallers を `human-ui` だけへ絞る案は、今の検査で表現できない。**起案時は「writer ごとの allowedCallers は `change-feed-writers.json:1829` などに既に例がある」と書いたが、確かめ直すと次のとおり。
  - `policies/narrative/change-feed-writers.json` の 76 件の variant（`authorityRoute` と `allowedCallers` を持つもの）は、すべて route の allowlist と完全一致する（JSON を読んで集計した）。`human-direct` の variant 16 件はいずれも `human-ui`・`manual-wrapper`・`typed-domain-api`。
  - `scripts/quality/validate-semantic-core-boundary.mjs:1253-1260` は、variant の `allowedCallers` が route の allowlist と一致しないとエラーにする。
  - `human-ui` だけの route は `attention-typed-writer`（`mutation-authority-routes.json:142`）だけで、これは Change Feed を出さない。`change-feed-writers.json` の :1829 は無関係な行で、:1784・:1865・:1870 の `allowedCallers` は別 route（`history-replay`・`import-apply`）の allowlist そのもの。
  - したがって「AI や `manual-wrapper`・`typed-domain-api` から規則を書けない」を allowedCallers の否定で固定する案（§11 の旧試験）は、この形では成り立たない。
  - **決めること（決めたことにしない）**：(a) `human-direct` の allowlist のまま使い、規則の writer の実装側で呼び出しが作者の UI 由来であることを検証する。(b) validator を「route の部分集合なら可」に改める（品質規則の変更）。(c) 規則専用の route を足す（新しい authority で、委任の外）。(c) は ADR 005 :1032-1033 が避ける Feature-private な authority に近づく。推奨は (a) の方向だが、`manual-wrapper`・`typed-domain-api` の中身と、writer 側で呼び出し元をどう検証できるかは未確認で、確かめるまで推奨を確定しない。(b)(c) になる場合は ★6・★7 の確認に含める。★6 の回答（2026-11-23）で (a) の方向。(b)(c) になる場合は改めて伺う。
- Freshness：規則の版の変更は Change Feed に出て、role `author-correction`（`policies/narrative/narrative-dependency-role-registry.json:76-77`、ADR 010 :139）の Dependency を通じて、その規則を使った提案の版を stale にする（規則 `author-correction-input-changed`、registry :217-224、consumerKind `proposal-revision`、`resolve-only`）。
  - 適用済みの Domain Data は書き換えない。Dependency の伝播は freshness だけ（ADR 005 Iron Law 9、:860-861、roadmap の ERM-2 の節の末尾「Dependency propagation alone may never perform it」）。
  - この role の語彙は、`src/features/narrative-semantic-core/contracts/dependencyRole.ts:16`、`src-tauri/crates/grimodex-core/src/narrative_dependency.rs`（:48・:138）、`src-tauri/crates/grimodex-core/src/narrative_ir.rs:2224`、`policies/narrative/schemas/narrative-dependency-role-registry.schema.json:476`、role registry（`policies/narrative/narrative-dependency-role-registry.json`）にある。しかし、この role を使う producer の宣言は `policies/narrative/` に無い（`narrative-dependency-producer-registry.json` に author-correction は無い。`grep` で確認）。v1 の案：その producer registry に抽出の producer の宣言を足す。**これは policy の契約を足すことなので、★2 の保存の確認と一緒に、新しい契約として確認する**（決めたことにしない）。索引・chat の consumer に同じ Freshness を足すのも、同じく新しい契約になる。
- 新しい writer は `policies/narrative/change-feed-writers.json` と保護 writer の一覧（`policies/narrative/protected-writers.json`、実装は `src-tauri/crates/grimodex-db/src/protected_writers.rs`。中身は未読）に登録する。
- schema の版：**今は 46**（`src-tauri/crates/grimodex-core/src/lib.rs:3` の `SCHEMA_VERSION: i32 = 46`。:9 の `PREVIOUS_COMPATIBLE_SCHEMA_VERSION` は 45、:10 の `PREVIOUS_COMPATIBLE_TARGET_SCHEMA_VERSION` は 46）。`src-tauri/crates/grimodex-core/src/workspace_schema.rs:798` の検査も `SCHEMA_VERSION == 46` を固定している。表を足すと 47 以降になる。ほかに版を取る見込みがあるのは、`docs/plans/nir1-proposal-findings-design-draft.md:70` の observations 表の CHECK の作り直し（「SCHEMA_VERSION 46→47」と明記）。**HSR/1 が版を上げるかは未確認**（この枝に HSR/1 の本文が無い）。したがって ERM が表を足す PR は、版を持つ他の PR と直列にし、**番号は merge の順で最後に決める**。

## 4. 優先順位と競合

適用の順序の案（Codex の抽出の照合 `matchExistingEntity`。§5 のとおり呼び出しは 3 箇所で、規則は 3 箇所の手前に当てる）。**規則と、作者の別名・exact-name が別の Entry を指すときの優先は決めること（§5.2 の 4）。次の順序は、その競合が無いときの適用の順の案**。
1. 作者の規則（scope が言及の場面に当たる active な `must-link-surface`）。
2. model が返す `explicitIdentityRefs`。**AI 経路が配線されたときの話**（今の seed 経路には `explicitIdentityRefs` が無い。§5）。`src/features/codex/extraction/existingEntityMatcher.ts:152-157` が最初に見て、1 件なら自動で解決する。供給元は `src/application/narrative-extraction/aiTasks/runEntityResolutionTask.ts:183-191`。
3. exact-name → exact-alias。敬称の除去・prefix・substring は今も自動で解決せず review の候補だけ（:143-144、:225-267）。この扱いは変えない。（`existingEntityMatcher.ts` は起案時（`2caf67a6`）から約 86 行増えた〔主に打ち手 2 の #899〕が、引いた位置のずれは 6〜8 行ほど〔例：`matchExistingEntity` の定義 :140→:146、`explicitIdentityRefs` の使用 :146→:152、ambiguous の返却は :175・:239・:250・:266〕）

規則と model が食い違うときは規則を採り、model の候補は「AI は別の人物を示した」として review に並べる（model の確信度は authority にならない。Iron Law 13、:867）。

競合（fail closed）。
- 同じ表記・同じ scope の active な規則が別の Entry を指す → どちらも当てず、表記を未解決に戻し、review カードに「規則どうしが食い違う」と出す。Structure Health（roadmap の P0-B）が入ったらそこにも出す。
- 規則の Entry が消えた・別 project → 規則を当てず、同じく表示する。
- 場面の規則と全体の規則が別の Entry を指す → ★5。推奨 A では場面の規則を例外として採る。これは作成時に作者が「例外」と明示した宣言で、勝者の自動選択ではない、と ADR に書く。
- 規則と、作者の別名（打ち手 1 で足された別名や、手で足した別名）が別の Entry を指す → 決めること（§5）。

Rejection と規則の違い（ADR 005 :581-604、Iron Law 7）。
- Rejection は「この版・この source basis・この scope で採らなかった」だけで、次の抽出を縛らない。
- 規則は以後の抽出を縛る。Rejection から規則を自動で作らない。作るのは作者の明示の操作だけ。
- 打ち手 3（却下を覚えて畳む、#906）は Rejection の覚えで、規則の v1 とは別の機構。この区別は変えない。

## 5. 適用の箇所と順序

### 5.1 `matchExistingEntity` の呼び出しは 3 箇所

`src` の `matchExistingEntity` の呼び出し（test を除く）は次の 3 箇所（`grep` で確認。`electron/`・Rust の別経路は見ていない）。

| 箇所 | 位置 | 渡すもの | 今の状態（旗が閉じた製品 build を基準に） |
| ---- | ---- | -------- | ---------------- |
| AI 経路 | `src/application/narrative-extraction/aiTasks/runEntityResolutionTask.ts:188-193` | `[canonicalName, ...surfaces]` と `explicitIdentityRefs` | `src` に test 以外の呼び手が無い。旗を開いても動かない。`src/features/codex/codexStructureExtractionApi.ts:1739-1741` は `request.useAi` が立っても何もしない「将来の配線」の stub |
| AI なしの seed 経路 | `src/features/codex/codexStructureExtractionApi.ts:1633-1636` | `[seed.surface]`（seed ごと） | 今の構造抽出の本線（旗を開いた build で動く）。ただし呼び手は `startCodexStructureExtraction`（:1514）→ `src/features/codex/CodexStructureExtractDialog.tsx:199` だけで、このダイアログは `structureReviewEnabled`（旗）のときだけ描かれる（`CodexCandidatesReport.tsx:309`）。**旗が閉じた今の製品 build では、作者の操作で動かない**。`explicitIdentityRefs` は無い |
| cluster の `candidateExistingRefs` | `src/features/codex/extraction/entityClustering.ts:244` | 束ねた言及の表記 | `clusterEntityMentions`（:98）に test 以外の呼び手が無い。旗を開いても動かない |

起案時の §4・§5 は AI 経路の `explicitIdentityRefs` の優先順位だけで書いていた。旗を開いた build で実際に動くのは seed 経路だけで、旗が閉じた今の製品 build では 3 箇所のどれも作者の操作で動かない（静的な読み。実行では未確認。旗の値は Vite の build 時の値で、作者が環境変数で開けるものではない）。したがって、以下の「規則が効く」「自動で通る」は、旗を開いた build の話である。規則は 3 箇所のどれにも効く必要があるので、**matcher の前段（3 箇所の手前、または `matchExistingEntity` の入口）で 1 回当てる**形になる。

### 5.2 決めること（決めたことにしない）

規則の位置は、今あるほかの機構との前後を決める必要がある。いずれも技術判断（M3 の委任の範囲）に入る見込みだが、このうち項目 3 と 4 は作者の画面で見える挙動なので、決める前に一覧で伺う。
1. **位置**：`matchExistingEntity` の入力に規則の結果を渡すか、3 箇所の手前の関数で先に当てて matcher を呼ばないか。後者は呼び出しを 3 箇所とも直す。
2. **打ち手 2（一括承認、#899）との前後**：規則で結んだ表記を、一括承認（`src/features/codex/extraction/entityBulkSafety.ts`、`BULK_EXACT_BIND_DECISION_SOURCE`）の対象にするか、規則は別の根拠（method）として 1 件ずつ review に出すか。
3. **打ち手 4（関係の呼び名の除外、#894）との前後**：今は seed 経路で、名簿に当たらない（`existingResolution.status === "none"`）ときだけ `relationalTermKind` で呼び名を落とす（`codexStructureExtractionApi.ts:1639-1645` の周辺）。作者が規則で結んだ呼び名を落とさないよう、規則を呼び名の除外の前に当てる必要がある。
4. **別名（打ち手 1、#903）・exact-name との優先と見せ方**：規則と別名が別の Entry を指すとき（§4 の最後の競合）に、規則を採るか、競合として止めるか、どう見せるか。§4 の順序の案は、この競合が無いときの話。

### 5.3 適用の箇所の表

| 順 | 箇所 | v1（案） | 根拠 |
| -- | ---- | -- | ---- |
| 1 | Codex の Entity の抽出の照合（3 箇所。§5.1。旗の裏） | 入れる案 | `existingEntityMatcher.ts:146`、review は `src/features/codex/CodexEntityResolutionPicker.tsx`（使用は `CodexEntityProposalReview.tsx:518`） |
| 2 | Chronicle の提案の参加者の表記の解決（**表示だけ**。「表示だけ」は、年表の参加者として保存しないという保存の範囲の話で、規則を作る入口の有無とは別。§8） | 入れる案 | 表記は `unresolvedMetadata.participantSurfaces` に未解決で残る（`src/features/chronicle/extraction/proposalPlanner.ts:141`、書込み :185-186）。表示は文字列の連結だけ（`src/features/chronicle/ChronicleEvidencePane.tsx:87-88`）。保存は §9-2 |
| 3 | 言及の索引・エディタの強調 | 後 | `src/features/codex/codexMatcher.ts`・`rustMatcher.ts` は作品全体の別名で照合し、場面の scope を持たない（構造からの推測）。規則で解決した人物を当てるときは hidden の判定を通す（§9-2） |
| 4 | 検索・Related Scenes・chat の文脈・Graph | 後 | ADR 013 の「残るもの 1」（IR admission と Graph の path 規則の見直しは PUB-G の後。013:21・:93・:107）に従う。起案時の理由「開示の方針（ADR 005 :1196-1197）を通す設計が先」は、位置づけがこちらへ移った（005 の本文は動いていない） |

- review 待ちの提案：Dependency の辺は規則を使った提案にしか無く、Codex の解決は hypothesis の作成時に決まる（`runEntityResolutionTask.ts:183-194`）。新しい規則は既存の提案を stale にしない。★8 で扱いを選ぶ：A＝規則を作った時に、同じ表記の未 review の提案に、AI を使わずその場で規則を当て直し、「ほかに 4 件に当てました［見る］」と件数を見せる／B＝次の抽出からだけ当てる。A でも適用済みの Domain Data は触らない。打ち手 1 の別名は B 相当（次の apply から効くだけ。`docs/plans/nir1-identity-review-load-reduction-design-draft.md` §8）。
- Chronicle では元の `participantSurfaces` を書き換えず、解決の結果を別の欄（どの規則の版か付き）として重ねる。**表示だけで、出来事の参加者としては保存しない**（§9-2）。
- 決定的な Core が同一性を推測しない原則（ADR 005 :409-410、:1191-1193）との区別：規則の適用は、作者が宣言した表記を正規化後の完全一致で引くだけで、推測ではない。敬称の除去や部分一致では規則を当てない。対象は Codex Entry の id で、Assertion の `assertionId` の扱い（:392-410、nullable のまま）は動かさない。
- AI への送信：推奨（★3 A）では規則の中身を送らず、model の出力の後に当てる。roadmap の ERM-1 の「Apply author correction rules before model confidence or fuzzy ranking」は判定の順序の話で、送らなくても満たせる。

## 6. 別名で足りる範囲と、規則が要る範囲

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

- 残る：場面で指す人が変わる表記（役職の呼称など。呼び名の一覧には入れていない）／exact-alias が複数の Entry に当たって曖昧になる（`existingEntityMatcher.ts:239`・:250 で ambiguous に止まる）／表記を Codex の別名にしたくない（別名にするとエディタの強調・検索で作品全体に効く。推測）／否定（「この表記はこの人ではない」）。抽出側の照合は `excluded_aliases` を見ていない（`existingEntityMatcher.ts` に excluded の参照は 0 件。言及側の `rustMatcher.ts:66-69` は見る。除外語は打ち手 1 の「別名に足せない」判定が見るだけ）。
- 実現した分は、規則の需要から外れる：作品全体で 1 人だけを指す敬称つきの表記は、打ち手 1 と 2 で、規則なしに次の抽出から自動で通る（旗を開いた build の話）。したがって「規則が要る範囲」は、起案時より狭い。review の負荷を下げる目的に規則がどれだけ寄与するかは、打ち手 1・2 の後の測り直しが材料になる（測定は事前登録側の話。本草稿は判断表を持たない）。
- 未実現：Chronicle の表記を別名で解決して表示し、1 クリックで別名に足す案（起案時の「別名での解決」）。`ChronicleEvidencePane.tsx:87-88` は今も参加者の表記を連結して出すだけ（年表の表示は別 lane が触る）。新しい保存が要らないので、規則の確認と独立に先に入れてもよい（推測：規則 v1 の §5.3 の 2 は、この表示に規則の層を足す形になる）。

## 7. 履歴と取り消し（ERM-3）

- 規則は版を足すだけで、上書き・削除をしない。取り消しは `state = retired` の新しい版（roadmap の ERM-3 の節）。作者の Undo は通常の Undo の系譜（`history-replay`、006:113-114）を使う。
- 提案の版は「どの規則の版を当てたか」の id を持つ。元の model の出力（hypothesis の payload と `explicitIdentityRefs`）は消さず、規則による解決は別の層として重ねる（roadmap の ERM-1 の「Preserve the original model output and layer the correction separately」）。
- 抽出をやり直したとき、どの規則が判断を変えたかを review カードに 1 行で出す（roadmap の ERM-3 の「Re-running extraction must show which prior correction affected a decision」）。
- 規則の取り消しで、適用済みの Domain Data は戻さない。依存する提案が stale になり、作者が review し直す。

## 8. 作者の操作の最小形

- **入口の問い（先に）**：下の「主な入口」の review 画面は、今は開発 build か、旗 `VITE_CODEX_STRUCTURE_EXTRACTION_REVIEW=true` を付けて build したときでしか開かない（この旗は Vite の build 時の値で、作者が実行時に設定できるものではない）。したがって製品の作者には見えない（`src/features/codex/codexStructureExtractionFlag.ts:1-18`。`CodexCandidatesReport.tsx:69`・:309・:490 の `structureReviewEnabled` が構造抽出のダイアログと入口のボタンを分ける）。つまり、規則の入口が「作者に見えない画面」にある。**規則を作る機能を作ることと、その画面を製品の作者に出すことは別の確認に分ける**（問いとして作者に伺う。上の「伺い方」。記録の問いの範囲外なので、同じ 1 回に添えるかは未確認）。画面を出す判断は、規則の確認とは独立に進められる。
- 主な入口：Codex の review で表記の人物を選んだ直後に、1 行の問い「次からも『（その表記）』→（その人物）にする？［この場面だけ］［全体］［しない］」。既定は［しない］で、何も押さなければ規則は作られない。
- Chronicle：未解決の参加者の表記を押すと人物の候補を出し、同じ 1 行の問いを出す（§5.3 の 2）。
- 一覧と取り消し：Codex の Entry の詳細に「この人物に結び付く表記」を並べ、各行に［この場面だけ／全体］と［やめる］を置く。hidden の人物にも出す（作者の画面）。AI に隠す人物の印を添える（§9-2）。
- 既存の `src/features/work-layer/CorrectionRulePreview.tsx` は UI のプレビューで、保存しないと画面に明記している（:63）。入口の候補だが、主な入口は review の場にする（推奨）。
- 作者に規則の型名（`must-link-surface` など）を見せない。

## 9. schema と送信の変更

- 新しい表（★2）：規則の版の表と、提案側の「当てた規則の版」の記録。保存範囲の拡大なので確認まで作らない。版の番号は §3 のとおり（今 46、merge の順で取り直す）。版を上げるとき同時に変わる箇所は、今回確かめた範囲で次のとおり（確かめていない箇所は載せない）。`src-tauri/crates/grimodex-core/src/lib.rs:3`（と :9・:10 の関連定数）、`src-tauri/crates/grimodex-core/src/workspace_schema.rs:798`、`SCHEMA_VERSION` を 46 に固定する試験（`src-tauri/crates/grimodex-db/tests/release_schema_migration.rs:179`、`narrative_change_feed.rs:407`、`workspace_migration_supervisor.rs:124`・:202）。そのほかの一覧（validator、generated schema、ほかの試験など）は報告から持ち込む前に確かめる（§12.2 の未確認）。
- AI への送信（★3）：推奨は規則の中身を送らない。B を選ぶ場合も、`reason` の自由記述と場面の対応は送らない案を基本にする。

### ★3 A が成り立つ 6 条件（設計の制約）

規則の中身を AI に送らない、は次の 6 つを守れば成り立つ（静的な読み。実行では確かめていない）。実装は、これらを設計の制約として守る。
1. 規則は新しい表（★2 A）に置く。`codex_entries` の列にしない（Main の読みの allowlist `electron/shared/mastraRead/tables.ts` の `MAIN_READ_TABLES`〔今 16 表〕に `codex_entries` が入っており、その全列を読める扱いかは報告から持ち込みで、この枝では再確認していない）。
2. 規則の表を Main の read core・standalone MCP・renderer の AI tool が読まない（allowlist・SQL・tool 定義に足さない）。
3. 規則を AI の request（名簿・prompt・tool の結果・context）に足さない。結果は model の出力の後にローカルで当てる。
4. 規則の結果を、AI が読む層（年表の参加者の保存、別名への具体化、言及の索引）へ流さない。流すなら、その経路の hidden の判定が入ってから（§9-2）。
5. ログ・audit に表記と Entry id を出さない。`change_events` に何を入れるかは、Freshness の設計（§3）との兼ね合いで**未確認**（payload の形と、AI 向けに読む経路〔MCP・audit bundle〕の有無が未確認）。件数だけにする案は Freshness と衝突しうるので推奨しない。`reason` に作者が hidden の人物の名前を書きうる点も、実装の前に確かめる。
6. 規則は model の出力の後に当てる。後段の抽出の AI request（関係・状態・Phase）は、実 Codex Entry の名前でなく不透明な Narrative Entity ID と観測の文だけを送るので、規則の結果は載らない（静的な読み、確からしさは medium）。

## 9-2. hidden を指す規則の扱い（2026-11-23 追加。いずれも推奨で、決定ではない）

ADR 013 の J2（013:282）は、Codex の hidden と年表の secret を「どの経路でも AI に渡さない」とする確認済みの目標で、例外は抽出の経路（作者視点。:115）と IME の辞書（ローカル）。ただし、年表の参加者名など :118-126 の漏れの一覧が残る間は、:128 が「主な内容の経路」の約束に限っている（直すまでの時限つきで、hidden を送らない向きで次の PR で直すのが既定）。規則が hidden の人物を指すときの扱いを、J2 を目標、:128 の限定と抽出の経路の例外を現状として、次のようにする。

1. **規則に hidden の状態を焼き付けない。使うときに、既存の入口で判定する。**hidden は Phase で場面ごとに変わる（`resolveCodexForAi`。`src/features/codex/context/codexHiddenFromAi.ts:59`、`listCodexIdsHiddenFromAi` :177、`visibleCodexForAi` :219）。規則の scope は場面を持つので、規則が指す人物が hidden かは規則を使う場面ごとに変わる。保存時に 1 回判定して印を持たせると、Phase が変わった後に食い違う。判定は cache しない（判定を再実装しない）。
2. **規則の表を Main の read の allowlist に足さない。**`electron/shared/mastraRead/tables.ts` の `MAIN_READ_TABLES` に規則の表を入れると、core が読める表になり、Main から規則を読める窓になる。standalone MCP にも読ませない（MCP は `context_mode` の述語を各 SQL が個別に持つため、JOIN を足すと忘れた瞬間に漏れる。報告から持ち込んだ事実。この枝で再確認していない）。
3. **v1 は、規則の結果を作者の画面に表示するだけにし、年表の参加者として保存しない案。**「表示だけ」は保存の範囲の話で、作者が年表の画面から規則を作る入口（§8）の有無とは別。年表の読み tool は hidden の Codex の名前を返す既知の非対称がある（`electron/shared/readDomain/core/chronicleTools.ts:45-50` が「Codex names are not filtered」と明記し、ADR 013 の漏れの一覧にも「年表の参加者名」がある）。規則で結んだ人物を出来事の参加者として保存すると、hidden の名前が年表の tool で出る。この非対称が直るまで（年表 lane の CSR/1 の N8 の merge の後。**N8 の本文はこの枝に無く未確認**）、保存へ進まない。
4. **エクスポートでは、規則を読者向けの書き出しから除く。**キャラクターブックは hidden・suppress を除く（`src/features/export/NovelExportDialog.tsx:89-95`）。規則の一覧を読者向けに出すと hidden の人物の表記が出る。作者の完全な保存（zip・snapshot・trash の restore）に規則を入れるかは別の決定（入れるなら復元の側の範囲と揃える。復元の lane の決定待ち）。取り込みで規則を運ばない（§10）。
5. **作者の画面には、hidden の人物を指す規則も出す。**ADR 013 D6（画面は作者に全部見せる。:91-97）に合う。hidden の人物には「AI に隠す」の印を添え、規則の中身が AI に行かないことを作者が読めるようにする。`get_ui_state` など、画面の状態を AI に渡す経路に規則や選択中の Entry を足さない。
6. **規則を使う箇所（言及の索引・検索・chat の文脈など。§5.3 の 3・4）は、規則で解決した人物の id を、必ず既存の hidden の判定に通してから入力に入れる。**
7. **確認文の約束の範囲：「規則の中身（呼び名と人物の対応）は AI に送りません」と書く。**「人物の名前を AI に送りません」とは書かない。J2 は「どの経路でも」を目標とするが、今は :118-126 の漏れが残り、:128 が「主な内容の経路」に限っている。さらに候補一覧の AI 判定の名簿が hidden を除かない疑い（★3 の範囲の注意）と、抽出の経路の例外（:115）がある。規則の確認文だけが、漏れを残したまま「人物の名前は送らない」という強い約束を新しく作ることになるため。

## 10. 脅威モデルの下書き（★7、確認まで draft）

1. 信頼する actor：作者（Human UI の `human-ui` caller）、native の typed writer。信頼しない actor：model の出力（`explicitIdentityRefs`・chat の tool 呼出しを含む）、本文の中の指示（prompt injection）、取り込みの package、renderer が申告する値、背景の保守・Reconciler、standalone MCP（v1 は MCP から規則を読み書きしない）。
2. 範囲内の攻撃：AI や本文の指示が規則を作る・変える／規則が黙って判断を変える／hidden の人物を指す規則が chat・検索・年表の tool・読者向けの書き出しで漏れる（§9-2）／消えた Entry を指す規則が当たる／矛盾する規則で勝手に勝者が選ばれる／取り込みで規則が持ち込まれる。範囲外：同じ端末で DB に直接触れられる者、作者が意図して誤った規則を作ること。
3. 必須の防御：書けるのは作者の UI からの呼び出しだけ（★6 A。**固定の方法は §3 の決めること**）、native で Entry の存在・同じ project・scope の形を検証し直す、版は immutable、競合と dangling は fail closed、規則を使う箇所は ADR 013 J2 の hidden の判定を通す（§9-2）、規則の中身は AI に送らない（★3 A）、提案に当てた規則の版を記録する、取り込みは v1 で規則を運ばない。
4. 受入れへの影響：Gold・閾値・評価の規則は変えない。規則を使う評価は別の arm として登録する。規則の変更は既存の提案を stale にするので、review の件数が一時的に増えうる。

## 11. 受入れ条件の案（roadmap の Exit criteria との対応）

| Exit criteria（roadmap の Epic P0-A の「Exit criteria」節） | v1（案） |
| --- | --- |
| 訂正した結び付けが、次の抽出で作者に聞かずに再利用される | 満たす見込み（案。Codex の抽出は旗の裏〔§5.1〕で、今の製品 build では作者の操作で動かないので、旗を開いた build での話。Chronicle の表示）。場面の規則は別の場面に当たらないことも試験する |
| cannot-link が同じ誤った merge の提案を防ぐ | 後回し（★4 B か ERM-2） |
| 矛盾する規則が fail closed し、Structure Health に出る | fail closed と review カードの表示は満たす。Structure Health は P0-B 待ち |
| Merge／Split の影響の preview と取り消し | 後回し（ERM-2） |

v1 の追加の条件（案）：規則の版の変更で依存する提案が stale になる／model の出力が規則と別に残る／AI が規則を書けない（**試験の方法は §3 の決めること。allowedCallers の否定では今は表現できない**）／規則を AI の request に含めない（★3 A の場合）／hidden の人物を指す規則が、読者向けの書き出し・年表の参加者の保存・AI の道具の結果に出ない（§9-2）。

## 12. 未確認の点と限界

### 12.1 確かめ方（2026-11-23 の改訂）

- **今回 `b7f8fa336` の内容で読み直した行**：`existingEntityMatcher.ts`（:143-180、:225-270）、`runEntityResolutionTask.ts`（:46-50、:180-196）、`codexStructureExtractionApi.ts`（:1625-1645、:1735-1745）、`entityClustering.ts`（:236-250）、`codexEntityHypothesis.ts`（:77-90）、`evidence/types.ts`（:11-16）、`codexCandidates.ts`（:25-30）、`codexStructureExtractionFlag.ts`、`CodexCandidatesReport.tsx`（:60-75、:146-149）、`CodexEntityProposalReview.tsx`（:6、:518）、`proposalPlanner.ts`（:139-145、:185-186）、`ChronicleEvidencePane.tsx`（:76-92）、`CorrectionRulePreview.tsx:63`、`rustMatcher.ts`（:64-70）、`policies/narrative/` の `narrative-ir-contract.json`（:33-51）・`semantic-core-authorities.json`（:15-23）・`mutation-authority-routes.json`（:20-28）・`narrative-dependency-role-registry.json`（:74-78、:215-226）・`change-feed-writers.json`（variant 全件の集計）、`validate-semantic-core-boundary.mjs`（:1240-1268）、`dependencyRole.ts`、`narrative_dependency.rs`（:48・:138）、`grimodex-core` の `lib.rs`（:1-12）・`workspace_schema.rs:798`、ADR 005 の :9・:850・:867・:1032-1033・:1196-1197、ADR 006 の :53-65・:139-143、ADR 010 :139、ADR 013（Status・:21・:93・:115-128・:282）、`mastraRead/tables.ts`（`MAIN_READ_TABLES` 16 表）、`chronicleTools.ts:40-52`、`NovelExportDialog.tsx:89-95`、`codexHiddenFromAi.ts`（:59・:177・:219）、`candidateJudgment.ts:90-96`、roadmap の Epic P0-A 節（ERM-0〜ERM-3・Exit criteria）。**追加で読み直した（2026-11-23、レビューの指摘の確認）**：`codexStructureExtractionFlag.ts` は 18 行、`CodexStructureExtractDialog.tsx:199`、`codexStructureExtractionApi.ts:1514`、`CodexCandidatesReport.tsx:309`、`ir/observations/entityIdentity.ts:44-47`、`ir/observations/eventOccurrence.ts:33-35`、`codexEntityHypothesis.ts:79-84`、`grimodex-core/src/lib.rs:9-10`、`grimodex-db/tests/` の 3 file の 46 固定の 4 か所、`narrative_ir.rs:2224`、`narrative-dependency-role-registry.schema.json:476`、`existingEntityMatcher.ts` の `2caf67a6` との行のずれ、ADR 013 :113-130・:280-284。
- **`2caf67a6` から diff が 0 件のため、起案時の行を持ち越したもの**：ADR 005・006・009・010 の本文（`git diff 2caf67a6 HEAD` で確認。上のうち読み直した行以外の :行は、この持ち越し）。roadmap は HEAD どうしの比較では差分 0 件だが、この PR が roadmap に追記し（基点 `b7f8fa336` の行から 11 行ずれる）、行番号は PR の状態で誤りになるので、節の名前で参照した。`policies/narrative/` では `narrative-ir-contract.json` と `change-feed-writers.json` に差分があるが、引いた行の内容は読み直して合っている。
- ADR の空き番号：local・remote・tag の全 ref の `docs/adr/` に 015 以上が 0 件（`git ls-tree`。2026-11-23）。打ち手 1〜4 の merge：`git log` に #894・#899・#903・#906 を確認。

### 12.2 未確認

- 2026-11-10 の「規則の ADR も起こす」の選択の原文（repo の docs・git log に見つからない。由来の行）。
- 他のセッションの未保存分が ADR 015 を予約していないか／HSR/1 が schema の版を上げるか（この枝に本文が無い）／CSR/1 の N8 の内容と merge の時期。
- 現行の抽出が既存の 2 Entry の同一視を提案するか。
- `sourceRef` が場面そのものを指すか（`NarrativeSourceView["ref"]` は string。場面の ref との対応は読み切っていない）。
- `manual-wrapper`・`typed-domain-api` の中身／規則の writer 側で呼び出し元が作者の UI 由来であることをどう検証できるか（§3 の決めること）／`protected_writers.rs` の中身。
- `codexMatcher`・`rustMatcher` が場面を持たないこと（構造からの推測）／別名がエディタの強調・検索で作品全体に効くこと（推測）。
- `change_events` の payload の形と、それを AI 向けに読む経路（MCP・audit bundle）の有無（§9 の条件 5）。
- AI の道具・standalone MCP が規則の表を読まないこと（§9-2 の 2 の MCP の述語は報告から持ち込み、この枝で再確認していない）。
- 旗が閉じた製品 build で、打ち手 4（`relationalTerms.ts`、候補一覧の `CodexCandidatesReport.tsx` からも使われる）と打ち手 3（候補一覧の却下の覚え）がどこまで効くか（§6.1。構造抽出の側が旗の裏であることだけを確かめた）。
- `electron/`・Rust の別経路に、`matchExistingEntity`・`runEntityResolutionTask`・`clusterEntityMentions` の呼び出しが無いこと（`src` の grep だけ）。
- 報告から持ち込み、この枝で確かめていない事実：候補一覧の AI 判定が hidden を除かないことの実行での確認（静的な読み、medium）、版を上げるときに同時に変わる箇所の完全な一覧（validator・generated schema・試験の行）、Rust の台帳（D2a）の pin 試験で新しい表の分類を決める必要があること、`profile_egress_policy` での新しい表の分類（PUB-G の領分）。
- 評価データの数値（repo の外。117 Scene の 2 作品で人物の表記 132 種／168 種など）。Codex が 0 件のため、規則で解ける割合は測れていない。

### 12.3 限界

範囲（第 3 章以降）は Order Oracle 待ち／同じ場面の同じ表記の 2 人は表せない／否定の規則は v1 に無い／言及の索引・検索・chat は v1 の外／規則の結果を年表の参加者として保存しない（§9-2）。

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
