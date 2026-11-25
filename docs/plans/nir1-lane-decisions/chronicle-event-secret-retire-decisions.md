# 年表の「AI に秘匿」の廃止（CSR/1）の実装の判断の記録

- 契約：`nir1-chronicle-event-secret-retire-proposal/1`（CSR/1）。本文は [nir1-chronicle-event-secret-retire-proposal-1-draft.md](../nir1-chronicle-event-secret-retire-proposal-1-draft.md)、台帳は [nir1-l6-l9-execution-plan.md](../nir1-l6-l9-execution-plan.md)（CSR/1-1〜6。#1037 で取り込み済み）。
- この lane は、NIR-1 の残レーンの委任の外である。規則・残る制限・脅威モデルは、ユーザーが確認した（確認 135）。この文書は、確認された本文の範囲内の、実装の技術判断を記す。**規則を変える判断は、ここに書かず、ユーザーに伺う**（DR-CSR-5）。
- 起案の本文は、台帳に取り込んだ後は変えない。起案の事実と、実装の基点のコードの違いは、ここに記す。
- **この版が扱うのは、起案の §5 の 3「MCP と Native の書き込みの門（N7・N8）」の PR だけ**である（MCP と Native。Rust）。アプリ内の読む側（N1・N8 (a)）、書き込み（N4）、取り込み（N6）、画面（N2）、印の PR 群（N3・N7 の `revealScene`・`scene_id`）は、別の PR で、この文書に足す。製品の変更は最後の凍結の前に master に入れ、公開版（release）に入れる前に、N11 の測定の結果をユーザーに見せる。

## 1. 実装の前の読み直し（2026-11-24）

起案の file:line は基点 `b7f8fa336` のもの。基点 `13282e2c0` の blob で取り直した。読みで、実行は後述の検証だけ。

- **MCP の `set_event_participants` は、MCP 自身の実装ではなく、Native の `agent_event_set_participants_with_request_impl` を呼ぶ**（`grimodex-mcp/src/tools/chronicle.rs`）。MCP の `db.rs` の `chronicle_set_participants` は、呼び出し元が無い（`#[allow(dead_code)]`）。アプリ内の IPC（`agent_event_set_participants`）も、同じ Native の本体を通る。したがって、参加者の保持（N8 (b)）は、Native の 1 か所に置けば、アプリ内と MCP の両方に効く。
- **作者自身の画面の操作（ChroniclePanel → `uiSetEventParticipants`）も、同じ Native の本体を通る。surface は `"manual"`**（`src/features/agent-writes/event.ts` の `UI_WRITE_OPTS`。Native の doc は「`manual`（UI手動編集）」）。起案は「AI の道具」だけを対象にしていたが、本体は AI と作者で共有されている。DR-CSR-4。
- **MCP の試験用スキーマ（`grimodex-mcp/src/db.rs` の `make_simple_db`）は、実スキーマ（`grimodex-db/src/migrate.rs`）と違う**：`event_participants.codex_entry_id`・`codex_entry_phases` の外部キーが無い。実スキーマは `event_participants.codex_entry_id → codex_entries(id) ON DELETE CASCADE`。外部キーの確認は、実スキーマを使う Native の試験（`event_participants_schema_rejects_missing_codex_foreign_key`）に置く。別の作品の codex id を参加者にする書き込みは、Native の `ensure_codex_in_project` が拒む（既存の試験）。

## 2. 判断

### DR-CSR-1　この PR の範囲

N7（MCP の読み・書きの入口から events の `secret = 0` を外す）、N8 の MCP 側（hidden の人物の除外）、N8 (b)（参加者の置き換えで base が hidden の既存の参加者を残す）。**入れない**：`revealScene`・`scene_id`・位置の印、`secret` 引数の削除（N4）、アプリ内の読む道具（`electron/shared/readDomain/`、`src/features/chronicle/`・`chat/`）、TS の `chronicleSecrecy.ts`、画面、取り込み。伏線の `foreshadows.secret`・版の印 `disclosure.secret`・Codex の hidden／suppress の判定そのもの・`events.secret` の列（消さない。新しく true を書く経路を足さない）にも触れない。

### DR-CSR-2　events の `secret = 0` の判定を外す（N7）

MCP の一覧・詳細・人物の年表・状態の入力（`chronicle_list_events`）、MCP の write-by-id の存在の確認（`ensure_event_visible_for_write`）と version の取得（`visible_event_version`・`visible_event_date_state`）、Native の `ensure_event_writable_for_surface` から、`secret = 0` だけを外した。**残す条件は `id` と `project_id`**（無い出来事・別の作品の出来事は「見つからない」。更新・削除の `baseVersion` の取得も残す）。「secret の出来事は見えない・書けない」を確かめていた試験は、「見える・書ける」に置き換えた（意図が変わるため）。`secret` の列の値を条件にした箇所は、伏線の表だけが残る（`db.rs:1679`、`tools/context.rs:338・363`。FSR/1 の範囲）。

### DR-CSR-3　MCP の hidden の人物の除外（N8 (a) の MCP 側。確認 97・100・109）

- **hidden の集合は、`db.rs` の 1 か所**（`chronicle_hidden_codex_ids`）で作る。条件は 2 つだけ：base の `context_mode = 'hidden'`、またはその項目に `context_mode_override = 'hidden'` の Phase がある。作品（`project_id`）で絞る。MCP は Phase を場面ごとに解決しない（確認 109）。名前の表に無い id（孤児・別の作品）は、規則に足さない。
- **入力の段で除く**：参加者は行ごと出さない。名前の表（`chronicle_codex_names`）から hidden の id を落とす。すると、主な人物・場所の名前は、既存の `name_or_null` で null になり、id は出ない。**出来事の `location_codex_id` は入力に残す**（`deriveLastKnownLocation` が、`locationCodexId` の無い出来事を飛ばして、より前の出来事の古い場所を返すのを防ぐ）。状態の道具は、選ぶ前の入力の**コピー**で、hidden の主な人物を `None` にする（元の行は変えない）。`chronicle_snapshot.rs`・TS の assemble／derive・共有 fixture は変えない（既定は除外なしで、TS と Rust の parity を保つ）。
- **人物の年表は、hidden の id と、名前の表に無い id（存在しない id・別の作品の id・孤児・空の id）で、同じ「見つからない」（null）**。hidden と存在しないを区別しない（存在の oracle にしない）。名前の表にあり、hidden でなく、関与の無い id は、今のまま（`events: []`）。
- 返り値のどこにも hidden の id・名前が出ないことを、一覧・詳細・人物の年表・状態の返り値の全体を検索する試験で固定した。**3 つのフィルタ（参加者・名前の表・状態の主な人物）を 1 つずつ外す変異で、試験が落ちる**ことを確かめた。

### DR-CSR-4　参加者の置き換えで、base が hidden の既存の参加者を残す（N8 (b)）

- Native の共通の本体で、DELETE の前に、base が hidden（`codex_entries.context_mode = 'hidden'`、同じ作品）の既存の参加者を役割ごと読み、要求の集合に無いものを足す（要求にあるときは要求の役割）。AI は hidden を抜いた一覧を受け取るので、そのまま置き換えると、見えていない参加が黙って消えるため。返り値（`AgentWriteResult`。参加者の一覧を含まない）、冪等性の hash、undo journal（実際の行から作る）は変えない。変更 event の `codexEntryIds` は要求のまま（残した hidden の id を feed に出さない）。
- **保持の条件は、アプリ内（`in-app-agent`・省略時）では base の hidden だけ**（起案どおり）。**MCP は、読みと同じ「base または hidden の Phase」に改めた**（確認 154。DR-CSR-9）。
- **surface の条件（独立レビューの P0 の直し）**：**作者自身の操作（surface = `manual`・`import`）は、hidden の参加者も含めて、要求のとおりに置き換える。** 残すと、作者が画面で hidden の参加者を外しても、黙って戻される。作者は全員を見ているので、残す必要が無い。AI の surface（`in-app-agent`・`mcp`）、省略時（旧経路の AI 互換）、未知の surface は、hidden を守る側に倒して残す。最初の実装は、surface を見ずに全部で残していた（「`agent_*` は AI だけ」という誤った前提。DR 1 の 2 つ目）。2 系統の独立レビュー（Claude・Opus と Codex、read-only）が、同じ指摘をした（重さは P0 と P1）。直しを外す変異で、新しい試験が落ちる。

### DR-CSR-5　残る制限と、ユーザーに伺う点

1. **【解決：確認 154。DR-CSR-9】Phase だけで hidden の参加者は、MCP の置き換えで黙って消える。** MCP の読みは、「base が hidden」か「hidden の Phase がある」人物を伏せる（確認 109）。しかし、置き換えで残すのは base が hidden の人物だけ（起案の N8 (b) は「base だけで足りる」と明記）。Phase だけで hidden の人物は、MCP の AI から見えないまま、置き換えで消える。起案の規則どおりに実装した（試験が「消える」を固定している）。**案：MCP の surface に限り、残す条件を読みと同じ「base か Phase」に揃える**（推奨。MCP の AI は、Phase だけで hidden の参加者を外せない）。アプリ内は、Phase が場面ごとに解決されるので、base だけのまま。規則の変更なので、ユーザーの確認が要る。
2. **【解決：確認 155。DR-CSR-10】`update_event` で、AI が hidden の主な人物・場所を上書きできる。** MCP では hidden の主な人物・場所が null に見えるので、AI が空いていると思って値を入れると、hidden の値を黙って置き換える。N8 (b) は参加者だけが対象で、この欄は守られていない。意図した範囲かどうかの確認が要る。
3. 書き込みの検査（`ensure_codex_in_project`）は `context_mode` を見ない。hidden の id を参加者・主な人物に渡すと成功し、存在しない id は失敗する（外に出るのは汎用の internal error だけ）。AI が hidden の UUID を当てる必要があり、MCP の読みから hidden の id を得る経路は見つからなかった。
4. `secret` の引数（`create_event`・`update_event`）は、まだ受け付ける（N4 で消す）。説明は「保存されるフラグで、MCP の読み・書きを制限しない」にした。値は、どこでも判定に使われない。
5. 題・メモの文中の名前は、hidden かどうかを判定しない（起案の残る制限）。
6. MCP の `db.rs` の `chronicle_set_participants`（使われていない古い置き換え）には、保持の処理が無い。呼び出し元が無いので、今の害は無い。
7. **アプリ内の読む側・書く側は、この PR の対象外**。この PR が master に入った後も、アプリ内の読む道具と書く道具（`isEventHiddenFromAi`）は、次の PR まで、secret の出来事を隠したままである。MCP とアプリ内で、一時的に見え方が違うが、公開版（release）には、全部が入った後でだけ出す（N11）。

## 3. 実施した検証（2026-11-24。どれも自分で実行した）

- `cargo test -p grimodex-mcp`：228 件が通過。`cargo test -p grimodex-db`（全件）：4,091 件が通過、失敗 0（レビューの直しの前の状態）。直しの後は `--lib agent_writes`（119 件）と `grimodex-mcp`（228 件）を再実行して通過。`cargo clippy -p grimodex-db -p grimodex-mcp --all-targets -- -D warnings`：通過。`cargo fmt --check`：変えた file に差分なし（`grimodex-db` 全体の差分は以前から）。
- 変異：hidden の 3 つのフィルタ、参加者を残す処理、base hidden の条件、作者の surface の条件を、それぞれ外して、対応する試験が落ちることを確かめた。
- 独立レビュー：Claude（Opus）・Codex（read-only）。漏れの経路（MCP の全道具と Native の返り値）は、2 系統とも問題なし。P0／P1（作者の操作で hidden の参加者が残る）は直した。P2（説明の不足）は直した。
- **していない**：実アプリ（Electron）での確認、`verify:quality` のローカル実行（hosted の Quick に任せる）、Windows・macOS。

## 4. 2 本目の PR-1：アプリ内の自動のまとめと書く道具（2026-11-24）

起案の §5 の 2（読む側と hidden。N1・N8 (a)）を、3 本に分けて出す：**PR-1（この節。renderer の自動のまとめと、書く道具の存在の確認）**、PR-2（port の型と、renderer・main の 2 実装。動作は変わらない加算）、PR-3（core の読む道具 4 本・検索の判定の削除、golden と試験の反転、`isEventHiddenFromAi` などの削除）。分け方の根拠は、範囲の調査（file:line つき。read-only）：renderer と core が `electron/shared/readDomain/features/chronicle/` の純関数を共有するので、純関数は先の PR に置き、関数の削除は最後の PR に置く。**起案の「port は `getHiddenCodexIds(projectId, sceneId, entryIds)`」は採らない**：Mastra の DR-MP4-39f が `listHiddenCodexIds(projectId, ids)`（場面は引数に取らず、呼び出し時に ctx の現在地から読む）と決めている（PR-2・PR-3 で使う）。`codex_entry_phases` の allowlist は PR-8a が足し済みで、この lane は変更しない。

### DR-CSR-6　自動のまとめ：出来事の秘匿の判定を外し、hidden の人物を入力の段で除く（N1・N8 (a)）

- `assembleChronicleSnapshotText`（`chronicleSnapshot.ts`）から、`projectVisibleChronicle`（出来事の `secret` を、現在の場面の読む順で隠す判定）の呼び出しを外した。secret の出来事も、まとめに出る。`projectVisibleChronicle`・`isEventHiddenFromAi`・`chronicleSecrecy.ts` の関数は、core がまだ使うので、PR-3 まで消さない。
- **hidden の人物は、選ぶ前の入力から除く**（選んだ後に消すと、hidden が枠を取ったまま消える）。新しい純関数 `chronicleHiddenCodex.ts`：候補（出来事の主な人物・場所、参加者、名前の表の key、シーンの人物、@mention）を集め、`listCodexIdsHiddenFromAi({ entryIds, projectId, sceneId })`（今の場面で Phase を解決する。DB に無い id も hidden に数える）の結果で、主な人物は **null にしたコピー**、参加者は行ごと除き、名前の表・シーンの人物・@mention から落とす。**出来事の `locationCodexId` は残す**（名前の表から落ちるので、名前は出ない。id を落とすと、より前の出来事の古い場所が「最後の所在」に戻る）。MCP の入力の段の除外（DR-CSR-3）と同じ形。
- **fail-closed**：`listCodexIdsHiddenFromAi` が失敗したら、hidden を除けないまま渡さず、年表のまとめを出さない（`undefined`＝注入スキップ）。`debugLog.warn` で記録する。候補が空なら、判定を呼ばない。
- 呼び出し元（`sceneContextSource.ts`）が渡す名前・シーンの人物・@mention は、既に閉じた項目を除いている。そこは変えない（二重に除いても害は無い）。

### DR-CSR-7　書く道具の存在の確認（N1）

`chronicleWriteTools.ts` の `visibleEventForWrite` は、現在の作品の出来事を id で探すだけにした（`secret`・読む順・scene events を読まない。`baseVersion` の供給は今のまま）。別の作品・存在しない id は「見つからない」のまま。secret の出来事を、更新・削除・場面との紐づけ・参加者の設定・関連の追加と削除で、id から扱える。

### DR-CSR-8　reveal の位置で隠すライブ評価の決定的な部分を、新しい事実に直す

`chronicleSecrecyEval.live.test.ts` の決定的な部分（key 不要・常時実行）は、「reveal シーンより前を書くとき、秘匿の出来事は年表に出ない」を固定していた。CSR/1 で、reveal の位置では隠さなくなる（確認 98・101・135）ので、「どちらにも出る」に直した。LLM のアーム（reveal 前は AI がネタバレを書けない、という比較）の前提は成り立たなくなった。「まだ明かされていない」の印（CPL/1 の W6。印の PR 群）が入った後に、評価を作り直す（ヘッダに明記した）。

### 残る制限（PR-1）

- 題・メモの文中に埋め込まれた hidden の人物の名前・id は、構造化された Codex id の除去の対象外（起案の残る制限）。
- （PR-3 で解消。DR-CSR-12〜14）アプリ内の読む道具 4 本・検索・golden・`normalizeEventFailClosed` は、PR-3 まで、secret の出来事を隠したまま（アプリ内の読む道具と、自動のまとめ・書く道具で、一時的に見え方が違う）。公開版（release）には、全部が入った後に、N11 の測定の結果をユーザーに見せてから出す。

### 検証（PR-1。2026-11-24。自分で実行した）

- `tsc`・eslint・prettier（変えた 10 file）・`validate:architecture`：指摘なし。renderer の広域（`src/application/composition`・`src/features/chat/agent`・`src/features/chronicle`）：143 files・2,422 tests が通過（5 skipped は既存）。`electron/shared/readDomain`：16 files・573 tests が通過。
- **変異**：組み立ての除去の素通し、fail-closed の無効化、純関数の参加者フィルタの除去、書く道具への secret の遮断の復活を、それぞれかけて、対応する試験が落ちることを確かめた。**このとき、組み立ての試験が、除去を素通しにしても通ってしまう（空虚）ことを見つけた**：fixture に場面の日付と人物が出る構造が無く、hidden の除去が無くても、名前がもともと出力に出なかった。「hidden が無ければ名前が出る」基準の assertion を足し、同じ入力で hidden ありのとき出ないことを確かめる形に直した。直した後は、素通しの変異で落ちる。
- していない：実アプリでの確認、canonical Light selector・`verify:quality` のローカル実行（hosted の Quick に任せる）。

## 5. 追加の 1 本（C2）：MCP の保持の条件と、AI の更新の保護（2026-11-24。確認 154・155）

2 本目の独立レビューが指摘した 2 つの穴を、ユーザーが「塞ぐ」と決めた（DR-CSR-5 の 1・2）。Native の `agent_writes.rs` と、MCP の道具の試験だけを変える。

### DR-CSR-9　MCP の参加者の保持：読みと同じ「base または Phase」に揃える（確認 154）

- hidden の判定を、**surface ごとに 1 つの関数**（`codex_entry_hidden_for_surface_sql`。`agent_writes.rs`）にまとめた。`mcp`：`context_mode = 'hidden'`、または `context_mode_override = 'hidden'` の Phase がある（MCP の読み `chronicle_hidden_codex_ids` と同じ。MCP は Phase を場面ごとに解決しない）。アプリ内の AI（`in-app-agent`・省略時＝旧経路）：base の `hidden` だけ（Phase は場面ごとに解決されるので、これまでどおり）。**それ以外の AI の surface（MCP・未知の値）：強い方（base または Phase）**。独立レビューの指摘で、未知の値を弱い方に倒していたのを直した（場面を解決できない surface は、守る側に倒す）。作者の surface（`manual`・`import`）は、保持しない（これまでどおり）。
- 参加者の置き換えの「残す」処理（DR-CSR-4）は、この関数を使う。返り値・冪等性・undo journal・変更 event の `codexEntryIds`（要求のまま）は変えない。
- 試験：Phase だけで hidden の参加者が、`mcp`・未知の surface では役割ごと残り、`in-app-agent`・省略時では消える。

### DR-CSR-10　AI の `update_event` は、現在の主な人物・場所が hidden の出来事で、その欄を変えられない（確認 155）

- **対象**：surface が `manual`・`import` でない更新（`mcp`・`in-app-agent`・省略時・未知。画面の手動編集は `manual`）。`primaryCodexId` または `locationCodexId` を渡したとき、その出来事の**現在の**値が、DR-CSR-9 の関数の意味で hidden の人物なら、**要求の値が現在と違うとき**（空文字＝解除も違うものとして）拒否する。同じ値を渡す（変更なし）・現在が NULL か hidden でない人物・他の欄だけの更新は、これまでどおり成功する。
- **拒否は、行・journal・change event を書く前**（検証の直後）。拒否のとき、`events` の行・`version`・`change_events`・`undo_journal` は変わらない。成功済みの同じ `request_id` の再送は、冪等性の検査が先なので、保存された返り値を返す。
- **文言は仕組みを明かさない**：`primaryCodexId cannot be changed on this event`（`locationCodexId` も同様）。「hidden」「secret」を含まない。MCP の道具を通すと、既存の `internal_err` により、AI に見えるのは汎用の `internal error` だけになる（理由は伝わらない。MCP 全体の既存の挙動）。
- **残る制限：拒否の成否が、AI に 1 bit 漏れる（独立レビュー 2 系統が指摘。Opus は P2、Codex は P1 と評価）。** (a) MCP では hidden の主な人物・場所が null に見えるので、AI が、見えている id（または空文字）を送り、拒否されれば「この欄は hidden の人物が持つ」、成功すれば「本当に空」と分かる。(b) AI が hidden の id を知っていれば、同じ値を送って成功するかで、「現在の値がその id か」を確かめられる。**評価：許容する。** 漏れるのは存在の 1 bit だけで、名前・内容は出ない。探りは無料ではない（現在が hidden でない出来事では、実際に書き換わり、undo journal・change event に残る）。(b) は hidden の id を知っていることが前提だが、MCP の読みから hidden の id を得る経路は見つかっていない（DR-CSR-5 の 3）。黙って無視する形にしても、読み直せば値が null のままなので、oracle になる。完全に塞ぐには、AI の主な人物・場所の更新を一律に禁じるか、作者の確認を経由させるしかなく、ユーザー決定（確認 155：hidden のときだけ守る）の範囲を超える。**ユーザーに、残る制限として見せる。**
- **残る制限：`delete_event` と `create_event` を続けると、hidden の主な人物・場所が外れる。** MCP の AI は、見えている出来事を消して作り直せる。明示的な破壊で、undo で全部戻る。確認 155 の脅威（空に見える欄を埋めて、黙って上書きする）とは別。作成の経路は、この PR の対象外。
- **範囲外（残る制限）**：現在の値が hidden でない（または NULL の）ときに、AI が hidden の人物を新しく設定すること（`ensure_codex_in_project` は hidden を区別しない。DR-CSR-5 の 3 のまま）。作成（`create_event`）の経路。

### 検証（C2。2026-11-24。自分で実行した）

- `cargo test -p grimodex-db --lib agent_writes`：125 件、`cargo test -p grimodex-mcp`：229 件が通過。
- **変異**（それぞれ、狙った試験が落ちる）：R3 の保護を外す、`mcp` の分岐を base だけにする、参加者の保持の SQL を base だけに戻す、作者の surface でも保護する。
- **独立レビュー**：Claude（Opus）・Codex（read-only）の 2 系統。R3 の迂回（IPC・MCP・一括・取り込み・undo／redo。作者の undo・redo は塞がれない）、surface のなりすまし（MCP は `mcp` を固定、アプリ内は Main が `in-app-agent` で上書き、AI は選べない）、SQL（注入なし・実スキーマと一致）、transaction（`BEGIN IMMEDIATE` の中・冪等の再送の後）は、2 系統とも問題なし。直した指摘：未知の surface を強い方に倒す、MCP の道具の試験に基準（hidden でなければ通る）を足す。残る制限として記録した指摘：上の 1 bit の oracle、`delete`＋`create`。

## 6. 2 本目の PR-2・PR-3：アプリ内の読む道具と検索（2026-11-24）

DR-CSR-9・10 は、C2（#1083。MCP の保持の条件と AI の更新の保護。確認 154・155。節 5）が使った。この節は 11 から続ける。

### DR-CSR-11　port `listHiddenCodexIds`（PR-2。動作は変えない加算。DR-MP4-39f）

core の年表の port `CoreChronicleData` に、`listHiddenCodexIds(projectId, ids): Promise<ReadonlySet<string>>` を足した（renderer と main の 2 実装）。**場面は引数でなく、呼び出しの時点の現在の場面**（renderer は `useTreeStore`、main は turn の入力）から読む。**cache しない。失敗は投げる**（fail-closed。道具が失敗として返す）。**DB に無い id・別の作品の id も、hidden に数える**（存在しないと伏せるを区別させない）。renderer と main で同じ結果になることを、parity の試験で固定した。

### DR-CSR-12　core の読む道具 4 本：出来事の秘匿の判定を外し、hidden の人物だけを伏せる（PR-3a）

- 4 本（`list_events`・`get_event_detail`・`get_character_timeline`・`get_chronicle_state`）は、出来事の `secret`・reveal の位置・読む順で隠さない。そのための `getTreeState`・`getReadingOrder`・`getSceneEvents` の読みが、`get_chronicle_state` の anchor のためだけに残った。
- hidden の人物は、port で判定する：`list_events`・`get_event_detail` は、主な人物・場所の名前を `null`、参加者を行ごと除く。`get_chronicle_state` は、人物を選ぶ**前**の入力（候補 id の収集 → `dropHiddenCodexFromChronicleInput`）から除く（選んだ後に消すと、hidden が枠を取ったまま消える）。出来事の `locationCodexId` は残す（名前の表から落ちるので、名前は出ない。`deriveLastKnownLocation` が古い場所へ落ちないため）。**モデルの `sceneId` は anchor の位置にだけ使い、hidden の判定の場面には使わない**。**候補 id には、空文字も入れる**（port は DB に無い id を hidden に数えるので、空文字の id の行が hidden でも取りこぼさない。独立レビュー〔Codex〕の指摘。PR-1 の `collectChronicleCandidateCodexIds` の「空文字は入れない」期待も、これに直した）。
- **画面で見える変化（ユーザーに見せる）**：`get_character_timeline` は、hidden の id と、**存在しない id（別の作品・空の作品の id を含む）で、「Character not found」（content `null`、tokensUsed 0）**を返す。以前は、存在しない id に `0 events for <id>`（空の年表）を返していた。MCP の読み（DR-CSR-3）と同じ規則になった。`tokensUsed` は、出る出来事・人物の変化に追随して変わる。

### DR-CSR-13　検索（`search_events`）：秘匿の判定を外す（PR-3b）

- core の検索の ctx から `chronicle`（events・scene events・読む順）を外した。main の `createMainChronicleSearchContext` は、DB を読まない。dense の fetchLimit（limit × 3）は、そのまま残した（hit が減らなくなったので、必要なら別に見直す）。
- renderer の legacy 検索（`toolExecutors.ts` の `chronicleCandidates`）は、秘匿の filter だけを外した。**IR の位置の filter と近似、そのための events・scene events・読む順の読みは残す**（IR は `CHAT_AGENT_IR_ENABLED` が false の間は休眠。`passesIrExclusionApproximation` は `event.secret` を今も読む。N9 で整理する）。

### DR-CSR-14　削除したもの（PR-3c）

`isEventHiddenFromAi`・`projectVisibleChronicle`・`VisibleChronicle`（`chronicleSecrecy.ts`。`readingPos`・`ReadingOrder`・`effectiveRevealSceneId` は残す）と、`normalizeEventFailClosed` の `secret` の検査（`secret` は core が判定に使わない）。`revealSceneId` の検査は残すが、**この PR の後、製品コードで `effectiveRevealSceneId` を呼ぶ所は無い**（試験と休眠の IR の近似だけ）ので、Main の読みで開示シーンの印を使う所は今は無く、保守的な残置である。N9 で整理するときに、まとめて外すか決める。

### 残る制限（PR-2・PR-3）

- 題・メモの文中に埋め込まれた hidden の人物の名前・id は、構造化された Codex id の除去の対象外（DR-CSR-6 と同じ）。
- hidden の判定は、呼び出しごとに DB を読む（cache しない）。1 つの道具の呼び出しで、`codex_entries`・`codex_entry_phases` の select が増える。大きい作品での負荷は、測っていない（N11 の測定の範囲）。
- **アプリ内の AI 向けの道具の説明が、まだ「secret の出来事は読みから除かれる」と言っている**（`toolDefinitions.ts` の `create_event`・`update_event` の `secret`・`revealSceneId` の説明と、`definitions.*.bytes.txt`）。この PR の後は事実でなく、モデルが「secret を付ければ自分から隠せる」と思い込みうる（hidden の人物が漏れる話ではない）。AI 指示の資産の変更なので、品質ゲート（`grimodex-author`）を通す別の PR にする。MCP の説明は、1 本目で「保存されるフラグで、読み・書きを制限しない」に直した。`secret` の引数を消す N4 で、まとめて直す。
- 空文字の id の Codex 行が hidden のとき、候補に入れない旧い実装では漏れうる、という指摘は、候補に入れて直した（アプリは空文字の id を作らないが、DB は禁じていない）。
- 公開版（release）には、全部が入った後に、N11 の測定の結果をユーザーに見せてから出す。

### 検証（PR-3。2026-11-24。自分で実行した）

- `tsc`・eslint・prettier（変えた `.ts`）・`validate:architecture`：指摘なし。renderer の広域（`src/application`・`src/features/chat`・`src/features/chronicle`）：327 files・5,320 tests が通過（8 skipped は既存）。`electron/shared/readDomain`：17 files・581 tests が通過。
- **変異**：renderer の `listHiddenCodexIds` を常に空にすると、特性試験と `get_character_timeline` の golden が落ちる。`revealSceneId` の検査を外すと、`readRows` の試験が落ちる。
- 実 addon の spec（`mastraReadParity.pipeline.spec.ts`）：年表・検索の部分は、2026-11-22 に作った addon でも通過（`search_scenes` の `scenes_live` の 2 件は、古い addon のため落ちる。この PR と無関係）。**最新の addon での確認は、hosted の `electron-native` に任せる。**
- golden は、差分の要点（secret の出来事が現れる・hidden の名前が `null`・存在しない id が not found・tokensUsed の追随）を読んでから再生成した。hidden の名前・id が golden に出ないことを grep で確かめた。
- **独立レビュー**：Claude（Opus）・Codex（read-only）の 2 系統。漏れの経路（5 本の道具の出力、renderer と main の両経路）、fail-closed、判定の場面、削除の取りこぼし、golden の差分の範囲、試験が空虚でないこと、`get_character_timeline` の変化の呼び出し元は、2 系統とも問題なし（P0・P1 なし）。直した指摘：golden の場面名が古い契約のままだった（名前を直して再生成。差分は `case` の行だけ）、古いコメント 3 か所、`db` 引数の説明、空文字の id（上）。残る制限として記録した指摘：AI 向けの道具の説明（上）、`effectiveRevealSceneId` の呼び出し元が無いこと（DR-CSR-14）。
- していない：実アプリでの確認、`verify:quality` のローカル実行（hosted の Quick に任せる）。

## 7. 書き込み側（N4）：AI・MCP から出来事の `secret` を書けなくする（2026-11-24）

起案の §5 の N4 のうち、**AI の surface（`in-app-agent`・`mcp`・省略・未知）の書き込み**だけを、この PR で入れる。画面（`manual`。「AI に秘匿」のチェック。N2）と取り込み（`import`・`narrative_extraction` の commit。N6）は、別の PR が直すので、**今のまま**にする。`events.secret` の列・既存の値・Field Authority の `/secret`・伏線の `secret`（FSR/1）には触れない。技術判断（AGENTS の委任の範囲。CSR/1 の確認 94・104・105 の帰結の実装）。

### DR-CSR-15　AI の surface は `secret` を書けない：`true` は拒む、`false` は黙って捨てる

- 「AI の surface」は、`payload.surface` が `manual`・`import` 以外（C2 の R1 と同じ判定。大文字小文字・空文字・未知は AI 側）。
- **拒むのは `true`**：受けて無視すると、`secret: true` を渡した AI が「守られた」と誤解するため。文言は `secret is no longer supported: events cannot be hidden from the AI`。**捨てるのは `false`**：既存の会話の履歴の模倣と、外部の利用者の互換のため。効果は同じ（出来事は隠れない）。
- アプリ内：renderer の実行側（`chronicleWriteTools.ts`）が、鍵が `false` でないとき（`true`・`"true"`・`1`・`null`）を、Native に届く前に説明つきで拒む。`false` は payload に入れない。main の検査（`agentMutationProjectionMatches` の近く）は背後の防御で、capability の発行側は不正な入力を黙って `continue` するので説明つきのエラーを返せない。モデルの入力の欄（`MODEL_TOOL_INPUT_SPECS`）には `secret` を**受ける欄として残し**、provider に見せる定義（`toolDefinitions.ts`）から消す（履歴の模倣が「欄に無い鍵」で説明のない失敗にならない）。
- MCP：schema から隠し（serde は読み続ける）、`true` は明示のエラー（`internal error` にしない）、`false` は捨てる。
- Native：AI の surface の create で `secret: Some(true)`、update で `secret: Some(_)` は、書く前に拒む（行・journal・change event を書かない）。update の検査は入力の検査なので、冪等の再送の検査・`base_version` の検査・`ensure_codex_in_project` の前に置く。作成の冪等ハッシュは変えない（未指定は false に正規化する今のまま）。

### DR-CSR-16　`revealSceneId` の説明を、効果を言わない中立の文にする

今の文（アプリ内・MCP とも）は「その場面で AI に見えるようになる／スタンプが無ければ永久に隠す」と言っており、CSR/1 の後は偽り。AI が「付ければ隠せる」と信じて使うのを防ぐ。新しい文は「読む順の場面 id を、この出来事の開示の場面として保存する。保存だけで、AI から隠さない」。**「選んだ出来事にだけ『読者にはまだ明かされていない』の印が付く」という N3 の効果は、印の PR 群（CPL/1 の W6〜W8・N7 の `revealScene`）が入る PR で、アプリ内の道具と MCP の両方を一緒に差し替える**（1 つの道具の中で、返り値と説明が食い違う期間を作らない）。`revealSceneId` 自体は残す（AI は付けられる。確認 69・73・110）。

### DR-CSR-17　この PR に入れないもの（順序の根拠）

- 画面の「AI に秘匿」のチェック（`ChronicleInspector` → `ChroniclePanel` の `uiUpdateEvent`。`surface = "manual"`）を Native が拒むと、N2 の前は保存が失敗するので、Native の拒否は AI の surface に限る。`api.ts` の `updateEvent` の `secret` 欄は、本番の呼び出し元が見つからなければ外す（実画面の経路ではない）。
- 取り込み（`narrative_extraction` の commit）は `apply_event_create_in_tx` を共有し、agent writer の entry を通らない。`secret = true` を必須とする検査（`commit.rs`）は N6 で直す。N4 は agent writer の entry だけを変える。
- undo／redo は journal の snapshot の replay で、update を通らない。既存の `secret` の値を運ぶので、変えない。

### 残る制限（N4）

- 画面の「AI に秘匿」のチェックと、取り込みが `secret = true` で作る動きは、N2・N6 まで残る（公開版には、全部が入った後に出す）。
- 過去に `secret: true` で作った出来事は、そのまま `secret = 1` で残る（読みでは使わない。既存の値は変えない）。
- AI の指示の資産（定義文・golden）の変更なので、品質ゲート（`grimodex-author`・`pnpm eval:impact`）は hosted で取る。

## 8. 画面の側（N2。2026-11-25）

年表の画面から「AI に秘匿」のチェック・「秘匿」のタグ・鍵を消し、開示シーンの欄を全部の出来事に出す。TS・文言・試験だけ（DB・Native・取り込み〔N6〕・提案レビュー・`agent-writes` の payload の契約は変えない）。技術判断（AGENTS の委任の範囲。確認 94〜98 の帰結の実装）。

### DR-CSR-18　年表の画面から出来事の `secret` を消す（N2）

- **編集欄（`ChronicleInspector.tsx`）**：「AI に秘匿」のチェックを消す。**開示シーンの欄は、シーンイベントを除く全部の出来事に出す**（今までは `event.secret` が true の出来事だけ）。選択肢「自動（初出シーン）」は「指定なし」（en `None`）に直す：選ばなければ、AI に何も伝わらない（確認 98。`effectiveRevealSceneId` の自動導出は、製品の呼び出し元が無い。N9）。**「指定なし」を選ぶと `revealSceneId: ""` を送る**（Native は更新で `null` と未指定を区別できず、`Some("")` を NULL にする。`agent_writes.rs`。`null` を送ると「変更なし」になり、選んだ開示シーンを解除できない）。説明文は、AI への効果を書かない中立の文にした（ja「読者に明かす場面が決まっているときに選びます。」、en `Choose the scene where this event is revealed to readers, if it has one.`）。**印の PR 群（N3・N7）が master に入る PR で、「選んだ場面より前を書くとき、『読者にはまだ明かされていない』と AI に伝えます。選ばなければ、何も伝えません」の趣旨に差し替える**（アプリ内の道具・MCP の `revealSceneId` の説明と一緒に）。
- **マーカー・一覧**：「秘匿」のタグと `aria-label` の状態（`EventMarker.tsx`）、鍵のアイコン（`ChronicleEventList.tsx`）を消した。配置の幅の計算（`chronicleLayout.ts` の `estMarkerWidth` の 32px／34px の加算）から `secret` を外した。表示用の型（`MarkerEvent`・`LayoutEventInput` など）から `secret` を外した。**DB 行の型（`EventRow`）の `secret` は残す**（読み取り側・スナップショット・書き出しは、値を運ぶだけ）。
- **ロケール**：`chronicle.secretLabel`・`secretDesc`（利用箇所なし）・`secretTag` を削除。`secretDescShort` → `revealSceneDesc`、`revealSceneAuto` → `revealSceneNone`。ja・en のみ（他の言語の file は無い）。
- **既存の `secret = 1` の出来事**：値は DB に残る。画面では見えず、編集もできなくなる（確認 95：知らせない。AI には、読み・MCP・アプリ内の道具で、もう全部渡っている）。
- **開示シーンが候補にないシーンを指すとき（N2 の後の直し。2026-11-25）**：開示シーンの欄を全部の出来事に出したことで、`reveal_scene_id` がアーカイブ済みなどのシーン（`scenes` の候補に無い id）を指す出来事で、欄が「指定なし」と見えるのに保存値が残り、「指定なし」を選び直しても change が出ず解除できない状態が、全部の出来事に広がった（merge 後の独立した読み直しと実 Chromium の描画で確認）。候補に無い id のときだけ、その値の option「（見つからないシーン）」（en `(Scene not found)`）を「指定なし」の次に出し、選択された状態で見せる。そこから「指定なし」を選べば `revealSceneId: ""` で解除できる。あわせて、試験名「指定なしは null で patch する」を、実際の期待値（空文字）に合わせて直した。
- **Native の `secret` の書き込みの拒否の最終形は、この PR に入れない**：N4 で AI の surface は拒否した。作者の surface（`manual`・`import`）は、N2 の後は画面から `secret` を送らなくなるが、取り込み（NEX の commit は `apply_event_create_in_tx` を直接呼ぶ）が `secret = true` で作る間は、全 surface の拒否を入れても取り込み経路は閉じない。N6 の後の別の小さな PR で、作成は `false` 固定・更新は `secret` を受けたら拒む（N4 の (c)）にする。

### 残る制限（N2）

- **N6 が入るまで、取り込みは `secret = true` の出来事を作る**（画面には出ない。AI には全部渡る）。公開版（release）には、N6・N3・N7・N9 の整理と N11 の測定の後に出す。
- 開示シーンの値は、N3・N7 が入るまで、AI に何も伝えない（保存するだけ）。説明文は中立の文のまま。
- 実 Chromium で、編集欄の変更前後（秘匿が ON の出来事・OFF の出来事）を確かめた。マーカーの幅・位置は `ChronicleViewport.browser.test.tsx` の case で固定した。

## 9. 取り込み（N6。2026-11-25）

AI 抽出の取り込み（NEX の commit）が、出来事を印なし・開示シーンなしで作る。Rust（`narrative_extraction`）・画面側の compiler・提案カード・文言・試験・実機の journey を 1 つの PR で変える（Rust と TS を別々に入れると、旧 Native が `secret = false` の operation を拒む、または旧 compiler の `secret = true` が組み立て直しと食い違う）。技術判断（AGENTS の委任の範囲。確認 104・135 の帰結の実装）。

### DR-CSR-19　取り込みは `secret = 0`・`reveal_scene_id = NULL` で出来事を作る（N6）

- **組み立て（画面と Native）**：画面の `compiler.ts` と Native の組み立て直し（`commit.rs` の `compile_current_chronicle_event_operation_payload`。`digest_plan` で照合）を、`"secret": false`・`"revealSceneId": null`（キーを出し、値は JSON の null。**`null` と省略は一致しない**）にした。版の `disclosure.revealDocumentRef`（IR の関門のために必須）の参照先の検査は残し、値は出来事に入れない。版の `disclosure.secret`（IR の admission）・`proposalPlanner.ts` の既定値は変えない。
- **検査の反転**：`NEX_CHRONICLE_APPLY_SECRET_REQUIRED` の検査を反転し、`secret = true` の operation を現行・旧形式とも**新コード `NEX_CHRONICLE_APPLY_SECRET_FORBIDDEN`** で拒む（提案への束縛・形式の枝より前に、操作そのものへ掛ける）。**独立レビューの指摘（P1）で、非 null・非空の `revealSceneId` も同じコードで拒む**ようにした（旧形式は operation の payload をそのまま比較するので、組み立て直しの照合に頼れない）。新コードは失敗の分類（invalidation の一覧）に入れた：**規則の前に準備された計画（保存済みの operation が `secret = true`）の apply は、`INVALIDATED` になる**（入れ忘れると `FAILED` の監査）。旧コード `SECRET_REQUIRED` は、もう発行されないので一覧から外した。
- **補完の除去**：`chronicle_operations.rs` の `apply_chronicle_event_create` の、`revealSceneId` が null・空のとき最初の根拠の場面（`scene_ids.first()`）を入れる補完を外した（呼び出し元は `commit.rs` の 1 か所だけ。AI の作成〔`agent_writes.rs`〕に補完は無い）。根拠の場面のリンク（`evidence_scene_links`）は残る。
- **提案カード**：「開示の場面」の入力（`chronicle-proposal-reveal-input`）と `handleRevise` の patch の型の `revealDocumentRef` を外した（`reviseChronicleProposal`・store の型と版のデータは残す。版の `disclosure.secret` のチェックは、SRA/1 の決定 17〔別の PR〕が外すので残す）。「まとめて承認」の見送りの理由 `reveal-scene-unresolved` は、符号を変えず、表示文を「根拠の文書の場面を確認できません」（en `Could not resolve the scene of the evidence document`）に直した（欄が無くなり、作者は直せない。検査は、版の `revealDocumentRef`〔根拠の文書〕が場面に引けるかを見る）。
- **試験・fixture・digest**：取り込みの operation・fixture を `false`／`null` に、取り込み後の期待を `(0, None)`（DB の行を直接読む）に書き換えた。`secret = true` の拒否（現行・旧形式）、旧形式の reveal つきの拒否、根拠の場面があっても `reveal_scene_id` が NULL、規則の前の計画が `invalidated`、を足した。現行形式の改ざん検出の試験は、`reveal-scene` の期待コードを FORBIDDEN に、`reveal-omitted`（キーの欠落）を足し、共有 Snapshot の試験は書き換える欄を `detail` にして元の意図を保った。`c2zc_restore_fixture.rs` の digest（`scripts/local-ci-full-workload-allocation.json`）を更新した。実機の journey は、作成された出来事が `secret = 0`・`reveal_scene_id` が null であることを見る。
- **変えない**：既存の取り込み済みの出来事の値（migration なし。確認 107）・`events.secret` の列・Field Authority の `/secret`・版の `disclosure.*`・IR の admission・Graph・`agent_writes.rs`（N4）・年表の画面（N2）。

### 残る制限（N6）

- **規則の前に準備され、まだ apply していない取り込みの計画は、apply で無効（`INVALIDATED`）になる**（`secret = true` の operation を持つため）。作者は、取り込みをやり直す（準備し直す）。作者に見える変化。承認済みの版・取り込み済みの出来事は影響を受けない。
- 無効になった計画の apply を再送すると、`NEX_COMMIT_NOT_PREPARED` が返り、`NEX_COMMIT_INVALIDATED` にはならない（status が `prepared` でないため汎用の検査が先。既存の挙動。独立レビューの P2。この PR では直さない）。
- **SRA/1 の決定 17（提案カードの版の `disclosure.secret` のチェックを外す）は別の PR**：版の印は IR の関門として残り、カードのラベルは `secret` のままで、作者には「出来事の秘密設定」と読めてしまう。決定 17 を入れるときに、代替の操作経路（実機の journey が、チェックで版を `false` にして IR の条件を満たしている）と一緒に決める。
- `agent_writes.rs` の `surface = "import"` は、明示値（`secret`・`revealSceneId`）を受け付ける（N4 の対象外。scan importer が実際に使うが、その呼び出しは値を渡さない）。Native の `secret` の書き込みの拒否の最終形は、N2・N6 の後の別の小さな PR。
- Electron の実機の journey（`chronicle-edited-apply-product-journey`）は、ローカルで走らせていない（hosted の `electron-native`・journey が確認）。
- **公開版（release）には、N3・N7（開示シーンの印）・N9 の整理が入った後に、N11 の測定の結果をユーザーに見せてから出す。**
