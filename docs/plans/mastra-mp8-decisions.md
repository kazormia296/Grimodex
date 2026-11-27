# Mastra 移行 MP-8 の判断記録（TS storage／vector adapter）

- 状態：**起案**。コードは変えていない。実装は確認事項の回答後、MP-7 の schema／Rust writer／N-API command が揃ってから。
- 基点：`origin/master` `2db49f806`（2026-11-26）。作業枝 `claude/mp8-design`。
- 前提：[移行計画](mastra-migration-plan.md) MP-7／MP-8、[MP-4 の判断記録](mastra-mp4-decisions.md)、[脅威モデル](mastra-migration-threat-model.md)。MP-4 の MP-8 申し送りは該当記述を確認できなかった。

## 1. 範囲

main の Mastra `MemoryStorage`、resource、observational memory（OM）、vector adapter を実装する判断を記録する。adapter は型付き N-API command を呼び、SQL と書込み規則は Rust に置く。旗 M は閉じ、adapter は試験からだけ呼ぶ。

MP-7a は進行中。schema 案の5表（`mastra_message_parts`、`mastra_thread_metadata`、`mastra_resources`、`mastra_observational_memory`、`mastra_memory_vectors`）はすべて D2a closed と申し送られているが、MP-8 はこれを完了事実とは扱わない。MP-7b の `memory_*` N-API command の形を MP-8 の要求として示す。

範囲は abstract 10（`dangerouslyClearAll` を含む）、OM 19、resource 4、vector 9 method、capability、thread／session 写像、本文 digest 化、turn 内 read cache、vector ID と削除保証、runtime owner との lifecycle。renderer の履歴移動、背景 route、M の公開は含めない。[計画:452-476]

## 2. 確かめた事実

- 計画は SQL を Rust に置き、main 専用の `memory_*` typed command を N-API に設ける。個々の payload は未定義。[計画:432-442]
- MP-8 の受入れ条件は、実 Rust adapter で S-M1 の差分試験、製品 adapter で P9 条件、実 Mastra の保存回数・行分割・signal を含む呼び順、並行試験。M は閉じたまま。[計画:470-476]
- spike の `kit.ts` は `FakeRustDb` を使う草稿で、本番 N-API／Rust 接続ではない。差分試験は同一の69操作で53件一致、16件差分。[spike `RESULTS.md`:32-38; `kit.ts`:422,1171。`git show claude/mastra-spike:spike/mastra/memory/kit.ts` で確認]
- 16件の差は、NOT NULL title の空文字、同時刻行の tie-break、InMemory 固有の人工エラー／`MessageList` の system 行除外、optional clone、atomic WM merge、run fencing の違いに分類される。`listMessagesById` は createdAt 順へ直した後に一致した。[spike `RESULTS.md`:39-51]
- OM capability を false／未宣言にすると、OM 有効時に履歴の読み書きも observer も黙って0回になる。partial thread update は title 省略を保つため true が必要。atomic WM merge と run fencing にも宣言と実装の整合が要る。[spike `RESULTS.md`:47-51]
- 計画の未解決事項は R-2（呼び順・1〜8回保存・1〜2 assistant 行）、R-4（WAL／busy／背景と前景の並行）、R-15（vector `message_id` と削除保証）。[計画:745-758]
- 脅威モデル W1／W8 は workspace runtime owner と adapter の in-flight 計数、W2 は turn read、W3 は terminal での保存、W7 は vector、W9 は workspace 切替の所有を要求する。[脅威モデル:312-351,391-424]

## 3. 判断（案）

- **DR-MP8-1 N-API 境界。** MP-7b に `memory_*` の型付き command 群を要求する。thread、message、resource、OM、vector の read／write／delete と memory 表だけの clear を、操作別の引数・戻り値で表す。任意 SQL、汎用 query、renderer からの呼出しは設けない。Rust が検証・SQL・transaction・typed refusal を所有し、main の薄い TS adapter は Mastra の形へ写すだけにする。payload と個々の command 名は MP-7b で確定し、本案は wire 契約を先取りしない。
- **DR-MP8-2 差分16件。** 全16件を本番 adapter の特性試験に移し、実 Rust 経路で再分類する。実 DB の表現差（title `""` 等）は Mastra から見た意味を保てば許容。順序・更新・削除・scope は同じ入力で同じ結果を要求し、同時刻は rowid／id の tie-breaker を明記する。人工エラー、InMemory の system 除外は製品要件にしない。clone／copy は未使用を確認し、必要になるまで未実装で拒否する。atomic merge は capability を true にするなら Rust 側で原子的に実装する。run fencing は有効化する場合だけ true とし、なしなら false を明示する。全16件の個別入力と期待値が揃うまでは parity 完了としない。
- **DR-MP8-3 capability と写像。** OM は true を宣言する。partial thread update は title 省略を「変更しない」として実装し true を宣言する。atomic merge／run fencing は実装済みの意味と一致させる。`title_manual`、metadata、空 title の往復を固定し、`nir1-local-*`／restricted は読み書きしない。`dangerouslyClearAll` は Mastra の専用表だけを消し、`chat_*` は残す。[計画:455-460]
- **DR-MP8-4 本文と入力。** 保存前に tool result を digest 化し、`providerMetadata.mastra.modelOutput` も保存しない。message の user／assistant／system 以外と差し込み user 行は Rust writer の条件に従い保存しない。attachment を memory message に通さない。[計画:461-462, MP-7 435-440; 脅威モデル D4、D9]
- **DR-MP8-5 cache。** 往復削減の read cache は main adapter 内、turn 単位で所有・破棄する。書込み後は該当値を無効化する。全 turn 共用 cache は置かない。キャッシュ有無で結果が変わらないことを試験する。[計画:466]
- **DR-MP8-6 呼出し・保存。** 実 Mastra の呼び順を記録し、1 turn の1〜8回の `saveMessages` と1〜2 assistant 行を前提に、buffer の commit／abort と #940 予約行の整合を定める。turn terminal の1 transaction、IMMEDIATE、workspace lease との合成は実 Rust で確かめるまで確定扱いしない。[計画:439-440,468; 脅威モデル W3]
- **DR-MP8-7 vector 削除。** `message_id` と保存行の ID 対応を Rust の正本で定義し、message 削除後に該当 chunk が残らないことを受入れにする。R-15 の原因と保証が解けなければ vector を有効化せず、旗 M は閉じたまま U-13 に戻す。[計画:463,476; R-15]

## 4. owner／lifecycle の表（GDX-PRECHECK-001）

| 経路                                 | owner・開始／再入                                                                            | closure・pending work                                                          | handle・取消し・有限待ち                                                                           | 終了証跡／error・restart                                                                                                           |
| ------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| adapter の生成・破棄（W1）           | main `MemoryRuntimeOwner`。workspace open／switch ごとに1つ。generation で古い start を拒否  | switch／close／restricted／quit 開始時に admission を閉じ、未送信仕事を cancel | owner が全 adapter／背景 handle を数える。run ごと AbortController。`T_settle` 内で settle を待つ  | inflight 0、各 audit terminal、Native terminal receipt。timeout は owner が記録し残りを cancel。process 内のみ、restart state なし |
| turn 読み・adapter command（W2／W8） | main turn owner／adapter。turn 内の read cache。既存 coordinator が同 session 再入を拒む     | W1 closure 時は `ADAPTER_CLOSED`。新規 N-API 呼出しを開始しない                | N-API Promise を adapter が計数。呼出し中の cancel なし。Rust の既存 `busy_timeout` と turn の上限 | Promise settle と inflight 0。typed Rust error を伝える。cache は turn 終了時に破棄                                                |
| 保存・vector（W3／W7）               | adapter buffer／background task。terminal receipt 時に commit、vector は message ID で冪等化 | terminal 後の保存拒否。未送信の背景仕事は closure で破棄                       | transaction は Rust 所有。embedding は abort 不可、有限待ちは `T_embed`                            | commit 戻り値、audit terminal、vector commit。曖昧な副作用を自動再試行しない。欠けた vector は再構築対象                           |
| workspace switch／quit（W9／W10）    | 既存 workspace owner／quit finalizer。runtime を participant 登録                            | 最初に W1 を閉じ、背景仕事 cancel                                              | W ごとの abort と settle を既存の `T_switch`／`T_quit` 内で待つ。値を本案で新設しない              | W1 の証跡後に次 runtime／storage close。timeout は所有者が記録し、未終端を成功扱いしない                                           |

待ち値は現行計画の記号を維持する。W1〜W10 の表と照合し、MP-11 で割当外の題名／背景 reflector の lifecycle を扱う。[脅威モデル:301-306,312-449]

## 5. 影響と PR の分け方

1. **MP-7b**：schema（7a）、Rust typed writer、main 専用 N-API `memory_*` command とその拒否・transaction 試験を先に揃える。MP-8 は payload を推測して追加しない。
2. **MP-8a**：thread／message／resource／OM adapter、capability、thread 写像、turn buffer／cache。fake ではなく Rust 経路で差分試験。
3. **MP-8b**：vector adapter、message ID の対応と削除保証。R-15 が解決してから接続。
4. **MP-8c**：実 Mastra の呼び順、R-2 の保存回数・行分割、R-4 の複数 session／window・WAL／busy・background／foreground 並行試験。全件が M 閉で通ってから後続 MP の統合へ。

MP-8 は `grimodex-node`／shared IPC contract の command、Rust DB、main adapter、特性・lifecycle 試験に届く。renderer／M の公開には届かない。実 Rust parity、P9、呼び順、並行性を受入れ条件にする。[計画:441-476]

## 6. 脅威モデルへの影響

本案は D4（attachment を memory に通さない）、D6（restricted 等を除外）、D7（scope）、D9（保存規則）、D10（削除）、D11（終了証跡）、D14（開示・consent）、D15（memory domain のみ）を実 adapter の受入れ条件にする。W1〜W3、W7〜W10 の owner を上表で MP-8 の作業に割り当てる。

新しい保存表／接続先、provider への新規送信、製品認可、契約、権限主体、閾値を本案で追加しない。したがって脅威モデルの T／D を変更する提案はない。schema 案の D2a closed と、実装上の parity／削除保証は別の完了条件として扱う。保存本文の digest と cache は既存の制約内であることを PR で証明する。

## 7. ユーザーに確認する点

回答の状況（2026-11-26）：U-15＝計画の範囲で端末の DB に保存してよい（開示・consent・保持は MP-12）。本節の技術の問い（N-API の形、16 件の差の受入れ、cache と待ち時間）は技術判断として 7b・MP-8 の実装で決め、判断記録に書く。

| ID  | 問い                                                                                                                                                                               | 推奨                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Q1  | `memory_*` は操作別の typed command 群とし、main 専用・Rust が SQL／検証を所有する境界を MP-7b の契約として具体化してよいか。既存の MP-7 schema 以外の保存表・保存範囲は増やさない | 具体化してよい                                       |
| Q2  | `mastra_memory_vectors` に本文 chunk を含む metadata を保存し、message 削除時に連動削除する案を採るか。既存計画にある保存範囲だが本文の複製になる                                  | 計画どおり採用し、D10 と R-15 の削除保証を必須にする |
| Q3  | `title_manual`、thread／session 写像と、`dangerouslyClearAll` が新表だけを消す契約を採るか                                                                                         | 採用する                                             |
| Q4  | cache を turn 内に限る案、及び `T_settle`／`T_embed` 等の既存記号を実測まで数値化しない案でよいか                                                                                  | 採用する。閾値を緩めない                             |
| Q5  | 16差分のうち人工 InMemory 挙動は parity 対象から外し、実 Rust 経路の16個の名付きケースを確定してから受入れ判定するか                                                               | そうする                                             |

## 8. 採らなかった案と、残る不確かさ

- FakeRustDb を本番 adapter とみなす：N-API／Rust の拒否、transaction、WAL、削除を検証できない。
- 全16差分を InMemory と無条件に一致させる：実 DB の空 title や artificial error など、製品仕様でない癖を契約にする。
- `supportsObservationalMemory=false` のまま進める：memory 全体が例外なく停止する。
- 全 turn 共有の cache：書込み後の無効化漏れで別 turn に古い値を見せる。
- vector の ID／削除保証なしに接続する：削除済み本文が残りうるため、R-15 を閉じるまで待つ。
- 未確認：16差分の全操作別一覧は `RESULTS.md` に集約されていない。named fixture 化の前に spike の生 JSON／実装を照合する。実 Mastra 呼び順、#940 予約行、Rust の並行性と clock／freshness への影響も未確認。[計画:745-747,758; 704-719]
