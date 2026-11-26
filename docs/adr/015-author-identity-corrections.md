# ADR 015: 作者の同定訂正を規則として再利用する

## Status

Proposed（実装・公開の承認ではない）

本 ADR は、作者の同定訂正を作品内で再利用する設計契約の提案である。作者が確認した方針を含むが、実装、機能の有効化、公開の可否は別に決める。未決事項と技術案は、確認済みの作者回答と区別して記す。

## Authority / related decisions

- [ADR 005](005-narrative-semantic-core-boundary.md)：Narrative Semantic Core の境界、Source と immutable revision の原則。本 ADR はその範囲を改めず、同定訂正の契約を追加する。
- [ADR 006](006-narrative-mutation-authority-routes.md)：作者による human-direct mutation と typed native writer。本 ADR の規則変更も既存の権限境界を通す案とする。
- [ADR 009](009-chronicle-temporal-model.md)：場面 scope の `any` / `exact` の契約。本 ADR ではこの scope 形式を使う案とする。
- [ADR 013](013-ai-disclosure-policy.md)：AI への開示方針。本 ADR はこれを置き換えず、既存の開示判定を引き続き適用する。
- [Narrative Semantic Core roadmap](../plans/narrative-semantic-core-roadmap.md)：Epic P0-A の ERM-0〜ERM-3 と Exit criteria を対象とする。

作者の回答により、新しい ADR として記録し、ADR 005 には参照だけを加える方針である。ADR 005 の Iron Law は変更しない。番号 015 は本 checkout での候補であり、統合時に重複がないか確認する。

## Context

現在の alias と除外語は、作品全体で一つの Entry に結ぶ単純な表記や、特定の候補を除く用途には使える。一方、表記の意味が場面で変わる場合、Entry 同士を同一人物として扱わない場合、候補間の優先、正式名の変更、同じ merge 候補の再提示抑止を表す履歴付きの規則ではない。

同定訂正は、作者が明示した対応を次の抽出や関連機能で再利用する機能である。モデル出力の書き換えではなく、モデルの出力と作者の規則を別々に保持し、決定的なアプリケーション層で解決する。

この ADR は規則の保存だけでなく、抽出・取込み・検索・文脈選択での適用、Merge / Split の影響表示と履歴までを一つの契約として扱う。roadmap の Exit criteria との対応は §8 に示す。

単純な alias で足りるのは、作品全体で一つの Entry を指す正の対応であり、scope・理由・変更履歴を必要としない場合である。それ以外の訂正を、既存 alias や proposal の却下記録に押し込まない。

## Decision

### 1. 作者が確認した方針

次の表は、草稿に回答として残る作者の方針である。実現の方法は、この表では定めない。

| 項目 | 作者の回答 |
| --- | --- |
| 記録先 | 新しい ADR として記録する。ADR 005 は参照のみとする。 |
| 保存 | 規則を作品ファイル内に保存する。規則と lineage を作者向け backup / restore に含める。 |
| AI への送信 | 規則の内容を AI に送らない。モデルの回答後にアプリ側で規則を適用する。 |
| 規則の種類 | roadmap の 5 種すべてを対象にする。 |
| scope の優先 | 同じ表記に作品全体規則と場面規則がある場合、場面規則を例外として優先し、作成時に例外であることを表示する。 |
| 作成の起点 | 作者の画面の操作で作る。Chat の AI tool からは作成しない。呼び出し元を本体側で確かめる仕組みは作らない（版 v4。脅威モデルの節）。 |
| 適用する経路 | 公開の前に、抽出・取込み・検索・関連シーン・chat の文脈・健全性に適用する。 |
| 保存直後の適用 | 同じ表記の確認待ち proposal に、AI を使わず直ちに当て直し、件数と結果を示す。 |

### 2. 規則の型と適用先

規則は immutable revision として保存し、作者が宣言した scope 内の決定的な照合に使う。次の 5 種を対象とする。

| 規則 | 意味 | 主な適用先 |
| --- | --- | --- |
| `must-link-surface` | 正規化した表記を特定の Entry に結ぶ。 | 抽出・取込み時の表記解決 |
| `cannot-link-entries` | 同一 project 内の Entry の組を、指定 scope で同一 entity として扱わない。 | 同一人物・merge proposal の抑止 |
| `preferred-binding` | 表記に複数の exact 候補があるとき、指定 Entry を優先する。 | 抽出・取込み時の候補選択 |
| `preferred-canonical-name` | Entry の canonical name を指定する。旧名を alias に残すかを記録する。 | 表示名と関連する提案 |
| `suppressed-merge-candidate` | Entry の組について、指定 scope で同じ merge 候補を再提示しない。 | Merge proposal の抑止 |

各 revision は author、time、scope、provenance、supersession、reason を持つ案とする。具体的な列、UI、migration は実装前に確定する。規則を更新・撤回するときは旧 revision を書き換えず、新しい revision と lineage を追加する。

表記の適用は正規化後の完全一致に限る案とする。部分一致、敬称除去、その他の推測で適用範囲を広げない。`cannot-link-entries` の Entry pair は順序を正規化し、同じ組として扱う。無効な scope、別 project の Entry、削除済みの Entry は適用しない。

通常の Codex 同一性は同じ Codex ID のみとする整理は、担当者の回答に基づく前提であり、作者の新しい決定ではない。Merge / Split の対応 lineage は ERM 側で記録し、M2 の identity 契約を代替しない案とする。

### 3. 保存と authority

規則 revision と Merge / Split lineage は作品ファイルに保存する。作者の回答により、これらを作者向け backup と restore に含める。restore 時の park、参照復元、変更 feed の意味は、保存形式と一緒に実装設計で定める。

作者の UI による human-direct 操作と typed native writer を使い、新しい authority を導入しない案とする。AI や本文中の指示を規則の作成・変更経路として扱わず、Chat の AI tool には規則 writer を提供しない。

規則変更と適用結果は Change Feed に記録し、依存する proposal の freshness を更新する案とする。依存の伝播だけで Merge / Split を実行しない。新しい table / writer は、Change Feed writer、protected writer、snapshot restore、profile egress の各 registry に登録する必要がある。

規則表の AI 向け汎用読取を閉じること、profile egress の分類、復元時の park mapping は実装前に確定する。backup / restore への保存承認は、読み取りと送信の区分の技術設計は、実装の前に別に確かめる。

### 4. 優先順位と競合

作者が確認した優先順位は、同じ表記に一致する場面規則が作品全体規則の例外として優先することである。場面規則を作る際は、作品全体規則に対する例外であると作者に表示する。それ以外の食い違いは勝手に選ばず、確認待ちに出すことも確認されている（脅威モデルの節）。

次の競合の判定の細部は技術案である。

1. 言及に一致する scope の規則を特定し、場面 scope と作品全体 scope の順に評価する。
2. 同じ優先度に矛盾する規則があれば、任意の勝者を選ばず unresolved として止める。
3. exact name / alias が規則と異なる Entry を示す場合も、黙ってどちらかを採らず競合として扱う。
4. 規則・model output・候補の confidence は別々に保持し、適用後も元の model output を残す。
5. 解決は、作者が競合規則を明示的に supersede / retire した後にやり直す案とする。

競合として検出する候補は、異なる Entry を指す重複した `must-link-surface` / `preferred-binding`、`cannot-link-entries` に反する binding または merge、同じ scope で抑止済みの merge、異なる canonical name の指定、消失・別 project・曖昧な lineage を含む規則である。対象と理由を review および Structure Health に示す案とする。

既存の Rejection は特定の proposal revision、source basis、scope に対する却下であり、恒久的な規則へ自動昇格させない。

### 5. 適用の順序と箇所

抽出経路では model output を保持し、候補の confidence や fuzzy ranking による結び付けより前に規則を決定的に適用する案とする。既存の `matchExistingEntity` の呼び出し箇所すべてで同じ規則解決を通す。規則自体は model に渡さない。

| 経路 | 適用する箇所（案） | 必須条件 |
| --- | --- | --- |
| Codex 抽出 | 候補照合の前 | scope、project 所属、競合を再確認する。 |
| Import | proposal 作成または apply の前 | 元の import data と provenance を残し、apply 前に scope と OCC を再確認する。 |
| Semantic Search | query と hit を Entry ID に結ぶ決定的な層 | 規則内容を query / AI request に含めない。 |
| Related Scenes | scene / Entry の関係を集計する前 | 未索引の影響をゼロ件と見なさない。 |
| Chat Context | provider 送信前 | 既存 ADR 013 の開示判定を適用し、規則内容を context に含めない。 |
| Structure Health | 競合・dangling target・参照欠落の検査時 | 原因と適用 scope を作者に示す。 |

同じ表記の複数言及が異なる scene scope に解決されるとき、一つの binding に強制せず review に残す案とする。適用不能な範囲を「影響なし」と扱わない。

#### 5.1 規則保存直後の当て直し

作者の回答に従い、規則の保存後、同じ表記の未適用・確認待ち proposal に AI を使わず当て直す。適用済み Domain Data は変更しない。

この処理には新しい read / write 契約が必要となる。read は project、正規化表記、scope を受け、対象 proposal revision と件数を返す案とする。write は rule revision ID と読取時の proposal revision ID を受け、OCC / stale を再確認して新 proposal revision を記録する。model output と review history は保持する。

応答には更新件数と、更新されなかった理由ごとの件数を含める。部分失敗を成功件数に混ぜない。既存の proposal revision 経路で安全に実現できるかは未確認である。

#### 5.2 Merge / Split と影響表示

Merge / Split は変更前に影響を列挙する Proposal とし、Change Feed の依存更新だけで commit しない。影響一覧は少なくとも次の領域を対象にする案とする。

- Codex Detail と Relation
- Phase / State
- Chronicle / Timeline
- Plot Thread / Foreshadow
- Map references
- Mention indexes と editor highlights
- Search、retrieval、packed contexts

各領域について対象 ID、件数、予定変更、対応できない範囲を示す。索引がない、または参照を列挙できないときは「未解決」と表示し、完全な影響表示ができるまで apply を止める案とする。

現在の schema では、Plot Thread に Codex ID の直接参照は確認されておらず、本文の `scene_codex_mentions` も位置を保持しない。そのため direct Plot Thread impact と本文位置ごとの完全な preview は現状列挙できない。必要な索引と逆引きの方式は未決であり、完全な preview の受入れ前提とする。

Merge は退役 ID から survivor ID への対応を、Split は一つの source ID から複数 target ID への対応を lineage に記録する案とする。Split では ID 対応だけで既存参照先は決まらない。参照型ごとの割当て方法は未決であり、自動で一つの target に割り当てない。

### 6. 履歴と取り消し

規則の変更・撤回は immutable lineage に新しい revision として記録する。過去の review history を書き換えない。再実行した review には適用した rule ID / revision と scope を記録し、元の model output と対応づける。

Merge / Split は影響を見せてまとめて行い、取り消せる。取り消しや当て直しは、後の他の変更を戻さず、適用済みや承認した提案に触れない（確認済み。脅威モデルの節）。operation と commit の履歴を残し、複数領域の変更を一つの atomic typed-writer commit に束ね、Undo 前に対象参照を照合するのは実装の案である。

全参照を列挙できない状態では完全な Undo を約束しない。未知の参照が残る場合は apply を止める。既存の複数 entity commit Undo を利用できる可能性はあるが、新しい writer が正しい lineage を作ることは別途受入れ条件とする。

### 7. 作者の操作

- Codex review で表記を Entry に結ぶ際、作品全体か場面 scope かを選ぶ。
- 作品全体規則がある表記に場面規則を作る前に、例外であることを表示する。
- 規則を作らない選択肢を残す。
- cannot-link は二つの Entry を同一 entity とする提案を止める操作として示す。
- Merge / Split は別の Proposal とし、変更前に影響と未解決領域を示す。
- 規則の一覧で scope、Entry、状態、provenance、適用履歴を確認できるようにする。撤回は新 revision として行う。
- 内部型名を主要な UI 文言として表示しない。

UI と画面の公開時期、既存 review 画面の作者向け提供状態は、この ADR では確定しない。

### 8. 受入れ条件と roadmap Exit criteria

| roadmap Epic P0-A Exit criteria | 受入れ条件 |
| --- | --- |
| 訂正した結び付けを次の抽出で作者に聞かず再利用する | 同一 scope の次の抽出と取込みで再利用し、scope 外に漏らさない。model output と適用 rule revision を確認できる。 |
| cannot-link が同じ誤った merge 提案を防ぐ | 同じ Entry pair と同等 scope では merge / same-entity proposal を出さず、scope 外を一律に抑止しない。 |
| 矛盾する規則を fail closed し、Structure Health に示す | 勝者を推測せず unresolved とし、rule revision、対象、scope、理由を診断できる。 |
| Merge / Split の impact preview と Undo が dependent data を orphan しない | 全影響群の対象と件数を示し、未解決参照を隠さず apply を止める。atomic commit を Undo し、参照、lineage、dependent data を復元する。 |

これらに加え、5 種すべての型と適用先、backup / restore、規則保存直後の非 AI 当て直しが各々の経路で検証されることを受入れに含める。部分失敗や stale input を成功として数えない。

本文の位置付き mention index と共通 Codex-ID reverse lookup が揃うまでは、完全な影響 preview を満たした扱いにしない。Split 後の参照割当てが未解決なら apply を許さない。評価閾値や Gold は本 ADR では変更しない。

#### 8.1 公開の前に必須の守りの試験

作者が確認した守り（脅威モデルの節）を、次の項目で確かめる。項目の分け方は実装の案で、どれも不合格なら公開しない。

- 隠した人物：AI への要求、AI の道具の結果、文脈に詰める内容、検索、読者向けの書き出し、年表の参加者の保存のどれにも、規則の中身、統合・分割の結果、理由の文、件数が出ない。判定は使う時点の場面の状態で行う。
- ログ（版 v5）：訂正の記録（event）は規則の revision の ID と種類だけを持ち、表記・項目 ID・場面 ID・名前・理由を持たない。作者が自分で出す監査の ZIP と timelapse の ZIP は守る先に含めない。
- 取込み：取り込むファイルの中の指示や内容から、規則も統合も作られない。
- 呼び手：AI の道具の一覧と MCP の公開する命令に、訂正の命令が無い（版 v4 の読み替え）。
- 対象：消えた項目と別の作品の規則は当たらない。
- 競合：場面の優先を除き、勝者を選ばず確認待ちに出す。
- 取り消しと当て直し：後の他の変更を戻さず、適用済みと承認した提案に触れない。
- 規則の中身は AI に送らず、版を残して書き換えない。
- バックアップと復元：規則の版の履歴、統合・分割の履歴と項目の対応表、提案がどの規則を使ったか、当て直しの結果が往復する。

前提の確認：event と audit の読み経路を照合し、隠した人物の情報が AI に出ないことを確かめるまで、規則と対応表の書き込みと、AI に渡る経路への適用は入れない。

## 脅威モデル

版 v3 は 2026-11-26 に作者が確認した。以下は草稿（`docs/plans/nir1-identity-correction-adr-amendment-draft.md` §10）から移した文面で、引用は伺った問いの文面そのもの。末尾の版 v4 は、同じ日の後の回答による変更である。

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

### 2026-11-26 の変更（版 v4）

問いの要旨：訂正の書き込みは本体側で「作者の画面の操作」と確かめられるまで開けないと決めたが、chat の AI の道具も画面と同じ場所で動くので、どの窓から来たかを見るだけでは区別できない。どう確かめるか（選択肢は確認ダイアログ・専用の確認の窓・先に調べる）。原文は handoff の `m3-user-answers-20261126c.md`。

回答（選択肢の外の自由な記述）：手間がかかるなら、脅威モデルとして、どこから来たかは確認しなくてよい。

- 外すもの：問い 1/4 の「本体側で確かめられる仕組みができるまで書き込みを開けない」と「確かめる仕組みが新しい経路になる場合は改めて伺う」。呼び出し元を確かめる仕組みは作らない。
- この回答は「手間がかかるなら」という条件つき。手間と見て省くのは起案者の判断で、問いでは確認ダイアログを作る量が少なめと説明していた。確認ダイアログを足してほしい場合は、足せる。
- 残るもの（確認済みの守りから）：訂正・統合・分割の命令を chat の AI の道具と外部の MCP に載せない。根拠は ★6 の回答（chat の AI からは作れない）、版 v3 の問い 2/4（知らないうちに規則や統合が行われることを守る）、問い 1/4 の「AI は提案を出すだけ」。今回の回答はこれらを撤回していない、というのが起案者の読み。
- 残るもの【起案者の読み】：背景の保守と取り込みは規則を作らない。native 側で引数を確かめる守り（消えた項目・別の作品の規則を当てない、hidden の判定、版の確認）。
- 限界：画面と同じ場所で動く別のコードがこの命令を呼んだ場合は、作者の操作と区別できない。
- 受け入れの守りの試験のうち「作者の操作だけが書ける」は、「AI の道具の一覧と MCP の公開する命令に、訂正の命令が無い」ことの試験に読み替える【起案者の読み】。既存の Codex の書き込みには agent 用の命令と main が付ける呼び手の区分があると下調べで報告されている（未照合）。PR 1 の設計の前に照合し、native 側で AI の道具・背景の保守・取り込みの呼び手を拒む試験まで足せるかを決める。

### 2026-11-26 の変更（版 v5）

経緯：作者の問い「ログにAIに隠すやつを出さないのは何故でしたっけ？べつにログには出して良くないですか？ログがAIが読めるからでしたっけ？」。下調べで、監査の ZIP は作品の変更の記録（`change_events`）を種類で絞らず全列そのまま出すこと、今ある Codex の編集の記録には本文の差分が入ることが分かった。advisor の意見（ログと作者が出す 2 つの ZIP は守る先に含めず、記録は ID と種類だけ）を本文で示してから伺った。原文は handoff の `m3-user-answers-20261126i.md`、contracts の M3 の確認記録の追記 40。

> 訂正の記録（ログ）の扱いを決めます。訂正の記録には規則の ID と種類だけを書き、名前・表記・対応・理由は書きません。そのうえで、作者が自分で出す監査の ZIP（共有前に確かめるよう画面で注意している書き出し）と timelapse の ZIP は、「AI に隠す」の守る先から外します。将来 AI・検索・読者向けの書き出しがログを読むようになるときは、その時点で隠す判定を掛けます（その機能は別に伺います）。この形でよいですか？

回答：「この形でよい（推奨）」。

- 改めるもの：版 v3 の問い 3/4 の (1) のうち「ログ」。ログは守る先そのものではなく、AI・検索・読者向けの書き出しへの経路として扱う。
- 残るもの：AI・検索・読者向けの書き出しに、隠した人物の訂正の中身・統合・分割の結果・理由・件数を出さない。
- 限界：今ある他の記録（例：Codex の編集の本文の差分）には隠した人物の名前や本文が入りうる。ログを AI に読ませる機能を作るときは、訂正に限らずログ全体に隠す判定が要る（別の作業）。

同じ日の回答（同じ記録の問 2）：作品のスナップショットで Codex を戻しても、訂正の規則と統合・分割の履歴は戻らずに残る。作品全体のバックアップからの復元では一緒に戻る。回答：「残す（推奨）」。

## Consequences

- 新しい schema と immutable rule / lineage writer が必要になる。migration 番号は実装時の統合順で決める。
- snapshot restore / park、Change Feed、protected writer、profile egress の registry と生成物を更新する必要がある。
- Import、Search、Related Scenes、Chat Context、Structure Health それぞれの canonical entry point で適用箇所を確定する。
- Merge / Split の共通 typed writer、影響列挙、atomic commit、Undo を実装する必要がある。現時点で専用 writer と共通の Codex 逆引きは確認できていない。
- 位置付き mention の完全な影響表示には index の追加が必要となる。
- 規則の中身を AI に送らないための読取・egress 分類を、既存 ADR 013 の境界に沿って確認する。

## 未確認・未決事項

- Split で複数 target に分かれる既存参照を、参照型ごとに作者が割り当てるか、別の制約を設けるか。
- Phase / State / Chronicle の実体変更が必要な場合、M2-D2〜D4 の identity 契約をどの段階で確定するか。
- 「公開前」が作者の apply / commit、読者向け export、外部公開のどの境界を指すか。
- scene scope を observation / proposal の sourceRef から scene ID に確実に対応づける契約。
- 同一表記 proposal の安全な再計画 read / write 経路と、部分失敗の結果表現。
- Import と Semantic Search の canonical entry point、Related Scenes と Chat Context の各 packed-context 境界に規則を適用する実際の経路。
- hidden 判定が対象となる全送信経路に届くこと、profile egress の closed 分類、保存表の restore park mapping。
- text mention index と共通 reverse lookup をどう実現し、preview の完全性を証明するか。
- 現行構成の静的調査に含まれていない参照経路がないか。producer registry や生成物の変更箇所も実装 PR 前に確認する。
- ADR 015 の番号が他の同時作業で予約されていないか。統合時に再確認する。

これらは未確認または未決のままであり、本 ADR の Proposed を Accepted に変えるものではない。規則が適用できない範囲を「影響なし」とみなさず、未解決として扱う設計案である。

## PR の分け方（案）

1. **PR 0 — ADR と受入れ契約**：本 ADR を確定し、ERM-0〜ERM-3 と Exit criteria、scope、競合、保存・Undo の境界を記録する。
2. **PR 1 — schema / rule / lineage 基盤**：immutable revision、Merge / Split lineage、typed native read/write、Change Feed、restore park、protected writer、profile egress を揃える。
3. **PR 2 — Merge / Split Proposal・影響表示・Undo**：参照列挙、atomic typed writer、multi-entity Undo を実装する。Split の参照割当てが解決するまで apply を開かない。
4. **PR 3 — 抽出・取込み・即時当て直し**：規則を適用し、同じ表記の確認待ち proposal に非 AI で当て直して結果件数を返す。
5. **PR 4 — Search / Related Scenes / Chat Context**：各 retrieval path で規則を適用し、provider 送信前に ADR 013 の開示判定を行う。
6. **PR 5 — Structure Health と受入れ閉鎖**：競合・dangling target・未索引参照を診断し、受入れ条件と roadmap Exit criteria を閉じる。

PR 2〜4 は PR 1 の後に独立して進められる。PR 5 は検出面が揃った後に行う。M2-D2〜D4 が必要な範囲は、依存関係を確定してから着手する。
