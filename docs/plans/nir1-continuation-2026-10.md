# NIR-1 続行計画の作業記録（2026-10）

更新日: 2026-10-19（初版: 2026-10-12）

| 項目 | 値 |
|---|---|
| 状態 | NIR-1 続行計画は 2026-10-12 にユーザーが承認済み。本書は G0 で作成した作業記録 |
| 計画 | `~/.claude/plans/610-pr-c-query-nir-valiant-thunder.md`（repo 外）。承認時（21:51 JST）の本文の SHA-256 は `0bfb2a90a0b1b0e13b39b99de825674647d88621afe30855d5bed2151efb474e` で、会話記録の承認本文と一致することを G0 で照合した。23:05 JST の改訂後は `f712102e78ca4e3dc217a6e6b1fc637e6a9085050d24e7b586fb6c179ee2e335`。改訂は、Ralph から Workflow subagent への切替（§1 の U3 変更）を記録する1行の追加だけで、その行を除いた本文の SHA-256 が承認時の値と一致することで照合した。2026-10-13 00:46 JST に、B-ROUTE の行と merge 列への B-ROUTE の挿入を足した。G0 の freeze の前には、B-ROUTE の扱い（C-product の前提、§3.1）の文言を直した。その時点の SHA-256 は `408a7a48d47e0f593b1a7c1e77620b8f11b77f40a7cfee3ec37a432645d03f8c`。承認後の改訂は integrator の運用上の記録で、ユーザーが承認したのは承認時の本文（`0bfb2a90…`）である |
| 基点 | `origin/master@a153743b3f672b7274bdd748f15ef9c216dc9961`（#629） |
| 現在地（2026-10-19 JST） | master は `b8a0bb7c`（#684）。2026-10-17 の Session B2 の記録（#668）の後、2026-10-19 までに次の PR が merge された（squash commit。詳細は §6）: #669 DF+、#670 X1-2、#671 DT-4、#672 決定の `created_at` を厳密に後にする修正（Full の揺れ）、#673 CB-1（schema v43）、#674 X1-3、#675 HS-1、#676 DA-1（`own-data-read` の開放 commit を除く。WebRTC の finding で止めた）、#677 DP-H（harness まで。evidence は HOLD）、#678 CQ-LIM-1〜4、#679 Session B3（K3/3）の確認の記録、#680 DT-5、#681 HC-1、#682 CB-2（＋MG-1）、#683 NC-1（K3/3 の実装）、#684 DI-1c。master の canonical Full は `a8ee82d5`（#683）まで green（run 39150424373）で、`b8a0bb7c` の Full は run 39154324262 で実行中（この記録の時点）。Session B1（K3/2、K4/3、K5/3、K6/2、X1/1。K6/2 の条件付きの2行は事前の確認のみで、条件の成立後に改めて確認を求める）と Session B2（K2/4 の2文と proposal/7 の1文）は 2026-10-17 に、Session B3（K3/3。`caller-profile-egress`）は 2026-10-18 に確認済みで、それぞれ §10.3、§10.4、§10.5 と確認台帳に記録した。K3/3 は、DA-1 の ST1 の Y-1 の試走が見つけた renderer の外向き通信（WebRTC の接続と名前解決）を Main の network 層で塞ぐ設計で、実装（NC-1）は #683 で master に入り、G-open の記録（Linux の実機）を [`nir1-lane-decisions/nc1-g-open/`](nir1-lane-decisions/nc1-g-open/README.md) に置いた。`own-data-read` の開放 commit（DA-1 の ST3）は、NC-1 の merge と G-open の記録の条件を満たしたが未実施で、実施の前にユーザーの確認を得る（§10.5）。PUB-G／PUB-L は Session C で確認する |
| 位置づけ | ユーザー決定、委任判断、レーン、merge 列、worktree 台帳の記録。契約の批准、閾値の変更、製品公開の根拠にはしない |
| 正本 | 契約と確認台帳は [L6〜L9実行計画](nir1-l6-l9-execution-plan.md)、残工程の依存と受入れは [post-B実行計画](nir1-post-b-execution-plan.md)、委任の規則は [GDX-PRECHECK-001](../../policies/quality/iron-laws.md#GDX-PRECHECK-001) |

## 1. ユーザー決定（逐語）

決定日は 2026-10-12（JST）。ただし U7 は 2026-10-13（JST）。integrator セッション（`3754f9a7-620d-4e21-ad37-3096691a96be`）の会話記録にあるユーザー自身の回答を、G0 で照合して逐語で転記した。U7 は同じセッションの会話記録にあるユーザー自身のメッセージを、merge 規則の変更時（2026-10-13）に逐語で転記した。選択肢を選んだ回答は、その選択肢の label を逐語とする。問いは要旨である。

SB-1〜SB-5 は、Session B の前にユーザーが出した決定と選択である（SB-1 は 2026-10-13、SB-2〜SB-5 は 2026-10-14、JST）。同じセッションの会話記録にあるユーザー自身のメッセージと構造化質問への回答を、2026-10-14 に照合して逐語で転記した（時刻は会話記録の timestamp）。SB-6 と SB-7 は 2026-10-18（JST）の決定で、Session B3 の記録の時に、同じ integrator セッション（`fa34d6ef-ff00-4f4d-846d-7ccee58abf30`）の会話記録にあるユーザー自身のメッセージと構造化質問への回答を照合して逐語で転記した（時刻は会話記録の timestamp）。どれも契約の確認文ではない。契約は、書き直した draft に対して、ユーザーが逐語の確認文を打ったときだけ確認される。契約の draft によっては、同じ決定を別の名前（K3 の /2 と K2 の /3 の UB1・UB2、K5 の /3 の UB-K5、K3 の /3 の UB3〔SB-6〕）で引く。

| ID | 時刻（JST） | 問い（要旨） | ユーザーの回答（逐語） | 計画での扱い |
|---|---|---|---|---|
| U1 | 17:22 | 2026-09-25/26 に Codex で回答された off-master 承認を master の確認台帳へ記録し、承認済み draft を保全してよいか | 「使わずに計画し直す」 | 9/25-26 の承認と WIP は参照扱いにとどめる。契約は最新 master 前提で、新しい draftRef（K1〜K6）として起案し直す。移植するコードは新しい候補として再試験・再レビューし、旧 review 証跡は流用しない |
| U2 | 17:22 | 承認済み草案（同時 2 MiB・8 ms 前提など）と #610／#611 の実装が食い違った。どう扱うか | 「2MiB/8ms はキツすぎてCodexでは達成できませんでした。何かいい案があれば挑戦してもいいかもしれませんが、現状は達成不可能です。」 | 2 MiB／8 ms は達成不能として扱い、現行の C-query 契約（100 ms result lease、aggregate physical-memory cap/proof なし）を前提にする。8 ms への挑戦は任意 |
| U3 | 17:22 | 今後の `[precheck]` 停止をどう運用するか。選択肢1は、#610 型の技術委任を NIR-1 の残レーンへ広げる案 | 「1でRalphを使ってやるかどうかは任せます。」 | #610 型の技術委任を NIR-1 の残レーン全体へ広げる（§3）。Ralph を使うかは integrator に任された |
| U3 追加 | 18:45 | 問いへの回答ではない。最初の計画提示（ExitPlanMode）を差し戻したときのユーザーのメッセージ。計画の承認は、21:51 の2回目の提示に対するもの | 「Ralphの実行はPiではなくClaudeCodeにしてください」 | エンジンは Claude Code にし、Pi と OpenAI は使わない。Ralph は Claude Code の backend で動かす（§5。23:05 以後の実装は U3 変更に従う） |
| U4 | 17:22 | 各レーンの到達点 | 「merge まで進める」 | 独立受入れと、rebase 済みの Quick＋verify、同じ head の `ci.yml` checks が green なら、squash merge まで進める（merge の条件は U7 で変更した。当初は hosted Full＋verify が green で、merge 直前に base を照合する条件だった。§6） |
| U6 前段 | 17:28 | #610 で共有定数が 2 MiB から 6 MiB に変わり、A2 の Revision 保存上限と B の per-Revision 入力上限も変わった。どうするか | 「そもそもこんなにキチキチにメモリを制限している理由がよくわからん」 | 制限の経緯（応答時間、壊れたデータや巨大データへの防御、物理メモリ上限の証明）を説明し、資源契約の方針を改めて問うた |
| U6 | 17:31 | 説明を受けた後、今後の資源契約をどうするか | 「防御用の上限だけに簡素化（推奨）」 | 資源契約は防御用の上限だけに簡素化する。新しい資源契約として K1 で一度だけ確認を求める |
| U5 | 17:28 | CI 保守（ProduceSkia allowance 10-17、pnpm audit 例外 GHSA-ch52-4w7c-c8xp 10-18、Dependabot 10件）をどう進めるか | 「この計画では扱わない」 | CI 保守はこの計画では扱わない |
| U3 変更 | 23:05 | Ralph（Claude Code backend）の新しい起動が、auto mode の安全判定（Create Unsafe Agents。Ralph が子の Claude Code を `--dangerously-skip-permissions` で動かすため）で拒否された。今後どうするか | 「Workflow subagent で続ける（推奨）」 | 以後の実装は Ralph ではなく Workflow subagent で行う（builder → Fable による reviewer → fix の順。§5）。Ralph で起動済みの最初の3レーン（CR-1、DT-1、HP-1）の記述は記録として残す |
| U7 | 10-13 22:22 | 問いへの回答ではない。CR-1 の Full 待ちなどの途中経過の報告の後に、ユーザーが出した merge 条件の変更の指示 | 「FullCIに時間が掛かり、Full中の並列PRのmergeによるbase stale 問題などが発生している。merge条件からCanonicalFullの合格を外す。「merge の直前に base が master と完全に一致していること」という条件も、一緒に緩める。たとえば「rebase して Quick が通れば可」にします。masterのfullで赤が出た場合、優先して対応するなどの運用でカバーする。ReleaseではFullCIのままにする。」 | 通常の PR の merge 条件から canonical Full を外し、rebase 済みの Quick と同じ head の `ci.yml` checks で merge する。merge 直前の base の完全一致も要求しない。merge 後に master の head で hosted Full を走らせ、赤は優先して直す。release PR と release tag は従来どおり Full を要求する（[GDX-TRACE-001](../../policies/quality/iron-laws.md#GDX-TRACE-001)。§6） |
| SB-1 | 10-13 19:40 | 問いへの回答ではない。K3 と K5 の書き直しの提案（renderer が乗っ取られうる前提は保ち、守る場所を「平文を外へ出す経路」に絞る。外へ出ない機能は制限モードでも開く〔K3 の O-2〕。local 送信の同意は送信先ごとに1回〔K5 の B〕）への返答 | 「それで行きましょう。K5はCで。ローカルLLMを使う人は基本的にリテラシーが高いと思うので釈迦に説法でしょう。」 | K3 は O-2、K5 は C（Main の同意ダイアログを置かず、利用者の AI 使用ポリシーと接続先の設定を同意とみなす）で書き直す。乗っ取られた renderer が設定を変えて送信を始めうることなどは残余として開示する。確認は、書き直した版（K3 の /2、K5 の /3 など）に対して逐語の確認文で行う |
| SB-2 | 10-14 04:06 | 問いへの回答ではない。K3 の /2 のレビューが、Web Editor の handoff の取込みを根拠に防御の追加を求めていたときの、ユーザーの指示 | 「web editorは廃止し、再公開の予定もないのでhandoffの考慮は不要です」 | Web Editor の handoff の取込みと、Web Editor を前提にした脅威・同意の議論は、K2〜K6 の契約と設計の考慮の対象外とする。製品からの取込み経路の削除は、別に依頼されたときだけ行う |
| SB-3 | 10-14 10:02 | 場面の本文を保存するたびに承認済みの型付き Revision がすべて失効し、執筆中は Graph が実質使えない（X1）。確認済みの契約は「本文・題名・順序の更新で旧 Revision を失効させる」と書くが、どの Revision かは書かず、L9 と post-B は本文の保存の後も履歴が続くことを求める。どう扱うか（選択肢は「本文では失効させない (推奨)」「依存するものだけ失効」「今のまま」） | 「依存するものだけ失効」 | 編集した場面の Scope の解決に依存する Revision だけを失効させる（L5 の `nir1-scope-dependency-delta/1` と同じ投影型の考え方）。新しい draftRef（`nir1-scene-scope-projection-proposal/1`）を起案して確認を求める。確認文が要らない委任の範囲の修正（X1-1。DR-X1-1）は先に進める |
| SB-4 | 10-14 10:02 | 50場面・場面ごとに review した現実の形では、主人公は約40件の Revision に入り、値を変えない最適化の後でも records 約900（上限512）、steps 約21万（上限10万）が要る。時間は最大 37.7 ms で 100 ms に収まる。資源の上限をどう進めるか（選択肢は「実測から決め直す (推奨)」「review の粒度を見直す」「今の値のまま」） | 「実測から決め直す (推奨)」 | 委任の範囲の最適化と数え方の修正（CQ-OPT、B-GUARD、CQ-AVAIL、CQ-MEM）の後に、現実の形の fixture で測り直す。その実測から records と steps の値、worker のメモリ（RB-2）と Revision の大きさの数え方（RB-1）を見直す資源契約の新しい版（proposal/7）を起案して確認を求める。100 ms の時間の上限は防御として残す |
| SB-5 | 10-14 10:02 | 主人公級の人物を seed にすると、2 hop で Entity が 12 を超えることが多い。確認済みの契約は「超えたら Graph 全体を出さない」。超えたときの挙動をどうするか（選択肢は「上限を上げる (推奨)」「決定的に打ち切る」「今のまま」） | 「上限を上げる (推奨)」 | 値は proposal/7 で実測から決める。それでも超えたときは、今どおり Graph 全体を出さない（部分的な Graph は出さない） |
| SB-6 | 10-18 02:07 | 問いへの回答。DA-1 の ST1 の Y-1 の試走が、renderer から外への接続経路（`RTCPeerConnection` の `iceServers` に `turn:`／`turns:` を渡すと Chromium が外へ接続する WebRTC の経路）を見つけ、`own-data-read` の開放 commit を `[precheck]` で止めた。integrator が文章で3つの選択肢（1: 構造的に塞ぐ設計を起案する〔推奨〕、2: 残余として開示して受け入れる、3: O-2 をやめる）を示し、どれにするかを問うた。AskUserQuestion の選択ではなく、通常のメッセージで答えた | 「１で行きましょう」 | 案1 を選ぶ。構造的に塞ぐ設計を K3/3（`nir1-d2a-activation-proposal/3`）として起案し、確認を求める。確認文ではない。確認までは、開放 commit、DA-2、activation の公開、PUB-G を止める。K3/3 の draft は、この決定を UB3 と呼んで引く（原文の出所は、K3/3 の引き継ぎ H6 に従い、ここに記録した） |
| SB-7 | 10-18 12:02 | proposal/7 の実装（CQ-LIM）の X1-3 の後の再測で「registration の使用量が Q の 85% を超える」に当たり、`[precheck]` で止まった。CQ-LIM をどう進めるか（AskUserQuestion。質問は 10:34 に提示。選択肢は「まず実装で直す（推奨）」「proposal/8 を起案する」「CQ-LIM を保留する」） | 「まず実装で直す（推奨）」 | 値は変えず、registration の処理を軽くして再測する。85% 以下に戻れば proposal/7 のまま進め、戻らなければ proposal/8 を起案する。実装で解消した（DR-CQL-13。#678）ので、proposal/8 は要らなかった。確認文ではない |

計画は 2026-10-12 21:51（JST）に承認された。U3 の「1」が指す選択肢の提示文は「#610 型の委任（worker/owner/終了処理/lifecycle の技術判断を作業記録に残して進める）を NIR-1 残レーンへ広げ、表記を 100 ms／aggregate cap なしへ更新する。新しい送信先・保存範囲・閾値緩和・製品公開・新しい契約は従来どおり確認する。AGENTS/iron-laws を更新する PR が必要。」である。表記の扱いは、承認済みの計画に従い、確認台帳の現行閾値と Gold への参照に置き換える。判断の記録先は §3.2 の形式に従う。提示文はユーザーの発言ではなく、選ばれた選択肢の範囲を示す記録として残す。

U3 変更で選ばれた選択肢の提示文は「Ralph の代わりに、このセッションの Workflow subagent（通常の権限、auto mode の安全判定あり）で実装する。進め方は builder→reviewer→fix で同じ。push、commit、gh を禁じる guard hook が無くなるが、subagent はこのセッションの権限判定の下で動くので、安全性はむしろ高い。」である。もう一方の選択肢（ユーザーが permission rule を追加して Ralph を再開する）は選ばれていない。計画ファイルには同じ 23:05 に、この変更を記録する1行（実行方式の「2026-10-12 の変更」）が追加された。この提示文もユーザーの発言ではなく、選ばれた選択肢の範囲を示す記録として残す。

## 2. 計画の要約

- NIR-1 の残工程を並列のレーンに分け、merge まで進める（U4）。製品入口（Graph、送信）は PUB-G／PUB-L まで閉じたままにする（A-1）。
- 9/25-26 の承認と WIP は使わず（U1）、契約は K1〜K6 として最新 master 前提で起案し直す。
- 2 MiB／8 ms は前提にしない（U2）。資源契約は防御用の上限に簡素化し、K1 で確認する（U6）。K1 は 2026-10-12 に確認された（§10.1）。
- 確認セッションは A（K1）、B（K2〜K6）、C（PUB-G、PUB-L）の3回とする。Session B は、K3〜K6 と X1 を示す B1（2026-10-17 に確認済み。§10.3）と、K2/4 と proposal/7 を示す B2（2026-10-17 に確認済み。§10.4）と、K3/3 を示す B3（2026-10-18 に確認済み。§10.5）に分けた。確認されなかった行のレーンだけを `[precheck]` で止め、ほかのレーンは止めない。
- CI 保守は扱わない（U5）。保守の失敗で PR の Security job が止まった場合は、merge 列を止めて実装を続け、ユーザーに報告する。master の Full が赤になった場合は、§6 の優先対応に従う（U7）。

### 2.1. 契約（起案予定。9/25 の文面は流用しない）

| K | draftRef と contractId | 止めるもの | 状態 |
|---|---|---|---|
| K1 | `nir1-l6-l9-contract-proposal/6`：`graph-limited-binding`、`nir1-defensive-resource-limits` | CR-REC の HOLD 解除、Graph の根拠、HC-1、DT-5、CB-4、CP-1 の数値 | 確認済み（2026-10-12、Session A。2行とも。§10.1） |
| K2 | `nir1-c-body-disclosure-proposal/4`：`graph-target-scene-body-disclosure`、`scope-storage-authority` の差分（/2 と /3 は確認を求めず superseded） | CB-1〜4、CP-3 の Graph-only 追加、G-01、PUB-G | 2026-10-17 の Session B2 で2文とも確認された（§10.4） |
| K3 | `nir1-d2a-activation-proposal/2`：`caller-profile-egress` の差分（/1 は確認を求めず superseded） | DA-1／2、CP-3a、PUB-G、DD-1 | 2026-10-17 の Session B1 で確認された（§10.3） |
| K3/3 | `nir1-d2a-activation-proposal/3`：`caller-profile-egress`（K3/2 と同じ contractId の新しい draftRef。renderer の外向き通信〔WebRTC の接続と名前解決〕を Main の network 層で塞ぐ設計。SB-6） | NC-1、DA-1 の ST3 の開放 commit、CP-2b、PUB-G、DD-1 | 2026-10-18 の Session B3 で確認された（§10.5）。実装（NC-1）は #683 で master。DA-1 の ST3 の開放 commit は未実施 |
| K4 | `nir1-d2b-history-mapping-proposal/3`：`history-reauthorization` の差分（/1 と /2 は確認を求めず superseded） | DF+-a、HS-1、HC-1、DI-1b／c | 2026-10-17 の Session B1 で確認された（§10.3） |
| K5 | `nir1-d2b-local-send-proposal/3`：`nir1-local-product-send` と、`caller-profile-egress` の差分（B-1〜B-4）の2文 | DF+-b、DT-4／5、DD-1、PUB-L | 2026-10-17 の Session B1 で2文とも確認された（§10.3） |
| K6 | `nir1-final-request-eval-proposal/2`：`nir1-final-request-packing-eval`（条件付きで `g01-eval-revision`、`graph-eval-procedure`）（/1 は確認を求めず superseded） | DP-H、DD-1、PUB-L、条件付きで CP-4 | `nir1-final-request-packing-eval` は 2026-10-17 の Session B1 で確認された。条件付きの2行は事前の確認のみで、条件は未成立のため効かず、条件の成立後に receipt を添えて改めて確認を求める（§10.3） |
| P7 | `nir1-l6-l9-contract-proposal/7`：`graph-limited-binding`（proposal/6 の資源の値の改訂。SB-4、SB-5。`nir1-defensive-resource-limits` は規則を変えず、確認文はない） | CQ-LIM-1〜4、C の受入れ（G-1、G-2）、PUB-G | 2026-10-17 の Session B2 で確認された（§10.4）。実装（CQ-LIM-1〜4）は X1-3 の merge の後の再測を終えて、#678 で master |
| X1 | `nir1-scene-scope-projection-proposal/1`：`scope-storage-authority` と `typed-revision-material` の差分（本文の保存で承認済みの Revision を失効させない。SB-3） | X1-2／3／4、K4 の前提 XP、CP-4 | 2026-10-17 の Session B1 で2文とも確認された（§10.3） |

確認は、確認台帳の protocol（[L6〜L9実行計画](nir1-l6-l9-execution-plan.md) の Confirmation protocol）に従い、1つの contractId につき exact draftRef を名指した1文で行う。draft は契約ごとに別ファイルにし、merge しない branch で SHA を固定する。確認された draft は byte 同一で台帳へ取り込む。

## 3. U3 の委任範囲と記録の形式

### 3.1. 委任範囲

- 対象レーン: C-resource、C-body、C-product、D-final 追補、D-transport、D-dispatch、H-store／H-current、DI-1、E。
- 委任するもの: worker／owner／終了処理／lifecycle の技術判断と、確認済みの actor・防御・受信先・受入れの範囲内での技術的脅威モデルの改訂。
- 委任しないもの（6項目）。該当したら `[precheck]` で止め、ユーザーの確認を求める。
  1. 秘密・データの新しい送信先
  2. 保存範囲の拡大
  3. 閾値の緩和（確認台帳の現行閾値と Gold の緩和・黙示変更を含む）
  4. 製品公開
  5. 製品認可の削除
  6. 新しい契約・authority
- 委任は NIR-1 の残レーンの外には適用しない。
- B-ROUTE（2026-10-13 追加）は C-product の前提として、C-product レーンの中で扱う。中身は、B の sealed binding を製品で作る経路（whole-project build と publish）を既存の maintenance 経路に配線することで、製品での起動は PUB-G まで閉じる。B の製品 activation（自動実行の既定を有効にすること）は委任に含めず、PUB-G の承認（Session C-1）で扱う。SPIKE S1 で、製品に publish の経路が無く、このままでは C-product の Graph が常に unavailable になることが分かったため。Session B のパケットで通知し、異議があれば merge の前に止める。
- 規則の正本は [GDX-PRECHECK-001](../../policies/quality/iron-laws.md#GDX-PRECHECK-001)。AGENTS.md の「作業範囲と完了」も G0 で同じ範囲へ同期する。
- 委任による判断は個別のユーザー承認ではない。integrator は判断と信頼境界を mutation の前に §3.2 の形式で記録し、難しい判断は read-only advisor に諮って明示的に決める。
- egress、subprocess、background、async lifecycle を変える場合は、先に有限の owner/lifecycle matrix を作る（GDX-PRECHECK-001）。

### 3.2. 委任判断の記録欄（各レーンが使う形式）

各レーン（DT-1、DT-2、DT-3、CR-1、HP-1、CP-2a など）は、mutation の前に次の列で1判断1行を記録する。記録先はレーンの decisions 文書と PR 本文で、本表には判断の ID と記録先を残す。PR 本文は mutation の前には存在しないので、mutation の前の記録は decisions 文書に書き、PR を作るときに PR 本文へ転記する。

| ID | 日付 | レーン／PR | 判断 | 信頼境界（actor・防御・受信先・受入れ） | 代替案 | advisor（requested／effective の model・effort、結論） | 除外6項目への該当 | owner/lifecycle matrix | 状態 |
|---|---|---|---|---|---|---|---|---|---|
| DR-0 | 2026-10-12 | G0 | 記録欄を作成した。G0 自体の技術判断はない | 変更なし | なし | なし | 該当なし | 不要（lifecycle を変えない） | 記録済み |

Session B のパケットで一覧として通知する委任判断（未記録。異議があれば該当 PR の merge 前に止める）:

- DT-1: startup claim barrier の状態遷移（Closed→Recovering→Open）と、gate を閉じ直す点。
- DT-2: create／claim／finish の bounded 化と既定値（DB mutex 100 ms、busy 100 ms、per-op 250 ms、drain 250 ms、sweep 5 s）、idempotency の鍵。
- DT-3: AttemptBinding v2（版 dispatcher、session と caller binding の分離、Scene への束縛、history slot の予約）。
- CR-1: lifecycle lane の必須集合。
- CP-2a: C-query の製品 owner、pre-warm、BUSY 時の扱い、env の方針。
- lifecycle の typed seam（DT-1、CB-2、CP-2a のうち最初に merge するものが導入する）。
- B-ROUTE: C-product の前提として、B の build と publish を製品の maintenance 経路に配線する（起動は PUB-G まで閉じる）。
- CQ-OPT（#657）: C-query の SQL の表の存在確認と relation bytes の読取を軽くし、steps を減らす。上限の値は変えない。
- B-GUARD（#660）: B の whole-project build で、承認されていない Revision は成分の大きさに関わらず除いて build を続け、承認済みで成分を超える Revision だけを typed に拒否する。whole-set の数え方と数値は変えない。
- X1-1（DR-X1-1）: project の Scope authority から tree の世代を外し、生きた Scene を含む folder の構造の変更で配下の Scene の Scope 世代を進める（ADR009 と NIR-0 C2B への整合）。
- CQ-AVAIL（DR-CQA-1〜3）: Graph の node の同一性から Scope を外し（本当の版の矛盾だけを拒否）、理由を型付きにし、空の Graph を worker でも返し、project 単位の読取を query で1回だけ読んで1回だけ数える。上限の値は変えない。
- CQ-MEM（DR-CQM-1）: C-query の worker の registration を S の領域で行い、未承認や非 current の Revision の JSON を解析しないようにし、query の一時的な複製を減らす。Q と S の値は変えない。
- CQ-LIM の registration の増幅の修正（DR-CQL-13、14。2026-10-18）: X1-3 が足した preflight の Entity の文で `entity_items` が `NOT MATERIALIZED` のため anchor の key の式が3か所に展開され、Entity の部分木の写しが Q に残っていた。`MATERIALIZED` にして解消した（返す値と判定の式は同じ）。proposal/7 の値は変えない。ユーザーの選択は §1 の SB-7。
- 決定の `created_at` の修正（#672。2026-10-18）: 承認と取消が同じミリ秒でも取消が効くように、決定の時刻を厳密に後にする。Full の揺れが見つけた不具合で、契約と上限は変えない。
- NC-1（K3/3 の実装。2026-10-18 追加）: K3/3 の確認の範囲の内側にある技術判断（module の構成、試験の形、段の割当てなど）は §3.2 の形式で記録して進める。範囲の外（許可先や名前解決を許す名前の追加、閉じた集合の外の network 設定、閉じ込めを止める入口、新しい authority）は委任しない `[precheck]` で、新しい draftRef を求める。
- DT-5、HC-1、CB-2（＋MG-1）、NC-1、DI-1c（2026-10-18〜19 に #680〜#684 で merge）: 確認済み契約の範囲内の技術判断は、各レーンの decisions 文書（[索引](nir1-lane-decisions/README.md)）に記録した。新しい数値（K1b の規則5）の記録は、DT-5 の DR-DT5-26（byte の上限と期限。draft の初期案のまま確定し、実在の local server の実測の根拠は無い）、CB-2 の DR-CB2-7 とその訂正、DI-1c の DR-DI1C-14（attempt の寿命 60 秒）、NC-1 の DR-NC1-3（LS-1 は確認済みの上限 256 接続・5000 ms のまま）。HC-1 は 1 turn の予算の数値を決めず、HC-1a の実測と推奨値（DR-HC1-12）を integrator に渡した。


### 3.3. レーンの判断記録の置き場所

各レーンの判断記録（§3.2 の行と、その根拠を書いた decisions 文書）は、追跡される [nir1-lane-decisions](nir1-lane-decisions/README.md) に置く。gitignore の対象（`.ralph/` など）や session の一時領域（/tmp）だけに置かない。PR 本文への転記は従来どおり行う。

DOC-REC（2026-10-14）で、それまで worktree の `.ralph/agent/decisions.md` にあった記録（DT-1、DT-2、DT-3、CR-1、HP-1、CP-1、B-ROUTE）と、integrator の作業領域にあった記録（CP-2a、X1-1、CQ-AVAIL、CQ-MEM）をここに置いた。worktree の片付けで消えた記録は会話記録から復元したもので、ファイルごとの根拠と確からしさは同じ場所の `PROVENANCE.md` に書いた。復元した記録は、当時の判断の記録として読む。後から本文を直さない。

## 4. レーン表

「実装」の列で、integrator とあるものは integrator が自分で書くか、Workflow の subagent を直接監督して実装する。Workflow subagent とあるものは builder → Fable による reviewer → fix の順で回し、その後に独立受入れを置く（§5）。Ralph とあるのは、Ralph の起動が拒否される前に Ralph（Claude Code backend）で起動した最初の3レーンの記録で、以後の作業は Workflow subagent で行う（§1 の U3 変更）。未指定のものは integrator が割り当てる。

| レーン | 内容 | 実装 | 開始条件と依存 |
|---|---|---|---|
| G0 | ガバナンスと doc-sync。本書、U3 と U4 の反映、現在地の同期、旧 draft の banner、quality-manifest と impact-map の分類 | integrator | 即時 |
| K1（Session A） | 資源契約 /6 の2文。2026-10-12 に確認され、G0 に同梱して台帳へ記録した（§10.1） | integrator（起案と adversarial review） | 即時 |
| SPIKE（S1〜S6） | 投資前の診断。merge しない | Workflow の subagent | 即時。計測は窓を分ける |
| CR-1／CR-REC | C-resource の閉鎖（opt-in lane の dispatch、ignored の実 worker 試験の配線、CQ-2、U6 の安全失敗、dataset の更新）と受入れ台帳 | CR-1 は Ralph で起動（以後は Workflow subagent）、CR-REC は integrator | 即時。CR-REC の HOLD 解除は K1 の後（K1 は 2026-10-12 に確認済み。解除には CR-1 の lane 証跡と独立受入れが要る）。CR-REC の記録は §10.2 |
| CP-0 | G-02〜G-08 の fixture・Gold・期待値の事前固定と P arm の足場 | Workflow の subagent と、それとは別の期待値 reviewer | 即時。Graph の出力を観測する前に固定する |
| DT-1→DT-2→DT-3 | D-transport の基盤（barrier と seam、bounded な create／claim／finish、AttemptBinding v2）。製品入口は作らない | DT-1 は Ralph で起動（以後は Workflow subagent）、DT-2 と DT-3 は Workflow subagent | 即時（U3 委任） |
| HP-1 | history 読取の前段（内部・未接続） | Ralph で起動（以後は Workflow subagent） | 即時。merge は DT-3 の後 |
| DSN | owner/lifecycle matrix、seam の API、join と frame、遅い Graph、renderer の切り出し、Main grant | Workflow で起案 | 即時。使う PR に同梱する |
| K2〜K6 の起案 | Session B 用の契約 draft | Workflow で起案し adversarial review | 即時。K2 と K4 を先に出す |
| CP-1、CP-2a | worker 内の pin join と NQG2、製品 owner | Workflow subagent | CR-1 の merge 後 |
| B-ROUTE（2026-10-13 追加） | B の whole-project build／publish を製品の maintenance 経路に配線する。自動実行は PUB-G まで閉じる | Workflow subagent | C-product の前提として U3 の委任で進める（§3.1）。Session B で通知する。CP-4 の前に merge |
| LEDGER-1 | Session B で確認された draft の台帳取り込み | integrator | Session B の後。Session B1 は #667、Session B2 は #668、Session B3 は #679（§10.5） |
| CB-1〜4（MG-1 を含む） | C-body v1 | CB-1／3／4 は Workflow subagent、CB-2 の writer と MG-1 は integrator | K2（2026-10-17 の Session B2 で確認済み）、DT-3、CP-1（どちらも master）の後。CB-1 は着手でき、merge は LEDGER-1 の後。CB-2 は CB-1 の後、CB-3 は CB-2 と並行、CB-4 は CB-1 と CP-1 の後に作り CB-2 の後に merge する（詳細は §10.4）。現状: CB-1 は #673、CB-2（＋MG-1）は #682 で master。CB-3 と CB-4 は着手できる |
| DA-1／2 | D2a の route 区分と activation | integrator | K3（2026-10-17 に確認済み。K3/3 を 2026-10-18 に確認）の後。DA-1: ST1・ST2・ST4 と ST3 の開放の前は #676 で master。ST3 の開放 commit（`own-data-read` を有効にする commit）は、NC-1 の merge と G-open の記録の後に入れる。条件は満たした（NC-1 は #683 で master、G-open の記録は `nir1-lane-decisions/nc1-g-open/`）。実施の前にユーザーの確認を得る（未実施。§10.5）。DA-2 は DA-1 の merge、MG-1（CB-2）の merge、CP-3a の merge の後（MG-1 は #682 で master） |
| NC-1（2026-10-18 追加。K3/3 の実装。名前はこの記録の仮の名前） | Main の network 閉じ込め（NC-1）、LS-1 の listener、FC-1、MD-1、`host-resolver-rules`（K3/3 の設計）。工数は約7日（推定。G-open の再走の幅を含む。harness の CI 化、更新経路の定期 CI、CP-2b の追加分は含まない） | Workflow subagent。高リスクの PR（起動の順序、network、listener）なので lifecycle とセキュリティの reviewer を2名にする（§5） | 開始条件: K3/3 の確認（2026-10-18）。DA-1 の ST1（#676）は master。merge は DA-1 の開放 commit（ST3）の前。ゲート G-open（Linux の実機。DA-1 の ST3 の開放 commit の条件）と G-pub（3 OS の packaged smoke。PUB-G の条件。CP-2b に Y-1 を各 OS で行うことを加える）。条件は K3/3 の draft のゲート表が正本（詳細は §10.5）。現状: #683（`a8ee82d5`）で master。G-open の記録は Linux の実機（`nir1-lane-decisions/nc1-g-open/`）。G-pub は CP-2b の範囲で未実施 |
| DF+-a／b | D-final 追補 | Workflow subagent | K4（a）、K5（b）の後。#669 で master |
| DT-4 | audit、route、consent | integrator | K5 の後。#671 で master |
| DT-5a／b | transport | Workflow subagent | K5、DF+-b、DT-1〜3 の後。DT-5 は #680 で master。DT-5a の主要な local server の実測は未実施（§11） |
| HS-1、HC-1a／b | history の保存と再認可 | Workflow subagent | K4、DF+-a、HP-1 の後。HS-1 は #675、HC-1 は #681 で master。HC-1a の実測は推奨値まで（数値は integrator が K1b の規則5で決める。§11） |
| DP-H | 最終 request 評価 harness | Workflow subagent | K6 の後。harness は #677 で master（2026-10-18）。evidence は HOLD: 観測により失効した版 1 の fixture を、別の作者が X1-3 の後のコードから導き直す置換 fixture と、独立 review の後に実行する |
| CP-3a／b | wire、IPC、seed の UX | Workflow subagent | CP-2a（master）、CB-4、DA-1 の merge の後（CB-4 は K2/4 の確認で着手できる）。CP-2a と DA-1（#676）は master で、残るのは CB-4 の merge |
| DI-1c／a／b | D1 最終統合（3分割） | Workflow subagent | c は DF+、DT-1〜3、HS-1 の後。a は CP-1／2a の後。b は HC-1 の後。現状: c は #684 で master。a は CP-1／2a の後に着手できる（どちらも master）。b は HC-1 の後に着手できる（HC-1 は #681 で master） |
| X1-1〜4（X1/1） | 本文の保存で承認済みの Revision を失効させない（SB-3） | integrator が割り当てる | X1/1 の確認（2026-10-17）。X1-1 は #662、X1-2 は #670、X1-3 は #674 で master。X1-4 は着手できる。列には置かない（§6） |
| CQ-LIM-1〜4（2026-10-17 追加。名前は proposal/7 の draft の仮の名前。2026-10-18 に #678 で master） | proposal/7 の実装（C-resource の追補）。CQ-LIM-1：`MAX_GRAPH_RECORDS` を Revision 用と query 用に分け、records・pages・steps・Entity・edge を変える（約2日）。CQ-LIM-2：Q 16 MiB、Native 領域 3 MiB、registration の検査（約3.5日）。CQ-LIM-3：RB-1 の writer の検査と台帳・試験の期待値の同期（約1日）。CQ-LIM-4：G-03 の作り直しと再 freeze（約1.5日）。合計は約8日（推定） | 未指定（integrator が割り当てる） | proposal/7 の確認（2026-10-17）。着手は X1-3 と並行してよい。merge は X1-3 の merge の後の再測を終えてから。CQ-LIM-4 は CP-4 の G-03 の観測の前と、CP-4 の観測前の commit の前に終える。現状: #678（`a789039a`）で master。X1-3 の後の再測で registration の使用量が Q の 85% を超えて `[precheck]` で止まったが、ユーザーが「まず実装で直す（推奨）」を選び（§1 の SB-7）、実装で解消した（DR-CQL-13）ので proposal/8 は不要だった。G-03 の re-freeze は独立 reviewer の approve を得て、`evals/nir1-graph/freeze.v1.json` の sha256 は `6080530adc0a7d2d45896005664f6f498d5f28c3eeed517875f8f599faa8bae7`（K2/4 の addendum はこの sha を引く） |
| CP-2b | worker の同梱と 3-OS packaged smoke | 未指定 | audit 例外が解消されていれば単独。解消されていなければ PUB-G に同梱し、Session C-1 でリスク判断を求める。K3/3（2026-10-18）で範囲が広がる: 3 OS の packaged smoke に Negative (34) を加え（G-pub）、Y-1 を各 OS で行う。観測の道具（packaged への CDP の注入、net log の取得、canary の受信 socket）の方式は CP-2b の着手時に決める。更新経路の定期 CI（K3/3 の引き継ぎ H1）の担当も CP-2b の担当が決める（条件ではない） |
| CP-4 | G-01〜G-08、24件、P の計測と A3 consumer activation の証跡 | 未指定 | CP-3a／b の後。計測窓で行う。X1-2 と X1-3 の merge、CQ-LIM-4（G-03 の再 freeze。Graph の観測の前）、観測前の commit（K2/4 の addendum。Graph arm の最初の観測の前）が開始条件（詳細は §10.4） |
| PUB-G | Graph の公開 | integrator | Session C-1 の承認後。K3/3 の G-pub（3 OS の packaged smoke で Negative (34)）が通ってから。K3/3 の確認は PUB-G と開示の文言を承認しない |
| DD-1、PUB-L | local 送信の製品入口と公開 | DD-1 は未指定、PUB-L は integrator | Session C-2 の承認後に PUB-L。DD-1 は、K6/2 の DD-1 の分類と K3/3 が加えた「続く通信」の2項目の両立（K3/3 の引き継ぎ H4）を K6 の確認者が判断するまで着手を保留する（integrator の運用。契約の条件ではない） |
| E-1、E-2 | journey と最終受入れ | 未指定 | 全レーンの後 |

## 5. 実行方式と precheck の記録

- エンジンは Claude Code。Pi と OpenAI は使わない（U3 追加）。
- 最初の3レーン（CR-1、DT-1、HP-1）は、Ralph を Claude Code の backend で起動した（`ralph run -b claude -c <レーン用 config> -P TASK.md -a --no-tui`）。config は repo 外の scratchpad に作り、root の untracked な `ralph.yml` は変えていない。
- その後の Ralph の起動は、子の Claude Code を `--dangerously-skip-permissions` で動かすため、auto mode の安全判定で拒否された。ユーザーの選択（§1 の U3 変更）により、以後の実装は Workflow subagent で行う。進め方は builder → Fable による reviewer → fix の順で、その後に独立受入れを置く。上の3レーンの以後の修正も Workflow subagent で行う。
- integrator が Workflow の subagent を直接監督して実装するもの: 契約、台帳、G0、MG-1 と CB-2 の writer、DA-1／2、DT-4、PUB-G／PUB-L、merge（計画で「Ralph に渡さないもの」としたもの）。
- 役割の分離: 実装（builder）、in-loop レビュー（Workflow の reviewer。Ralph で起動したレーンでは Ralph の Reviewer を含む）、候補を編集しない独立受入れを兼務しない。in-loop レビューの合格を独立受入れの代わりにしない。高リスクの PR（DT-1、DT-2、CB-2、DA-1／2、DT-4／5、PUB-G、PUB-L）では lifecycle とセキュリティの観点を2名にする。
- Claude 実行（Ralph と Workflow subagent）の precheck（GDX-PRECHECK-001 の external Claude review 規定に準ずる）:
  - 送るデータ: repo のコード、文書、試験ログ。秘密情報と認証情報は含めない。
  - 許可: この計画の承認による。
  - モデル: Builder は `claude-opus-5-5`。Reviewer、Advisor、独立受入れは `claude-fable-5-1`（effort は high）。Fast は使わない。
  - 記録: requested と effective の model・effort、Fast の有無を PR とレーンの記録に残す。

## 6. merge 列と各 PR の手順

順序（実装とレビューは並列でよい。merge は1本の列で、準備できた順に入れ替えてよい）:

G0 → CR-1 → CR-REC → CP-0 → DT-1 → DT-2 → DT-3 → HP-1 → CP-1 → CP-2a → LEDGER-1 → B-ROUTE → CB-1 → DA-1（開放 commit を除く。#676）→ NC-1 → DA-1（開放 commit）→ CB-2（＋MG-1）→ DF+-a/b → HS-1 → DT-4 → DP-H → CB-3 → CP-3a → DA-2 → CB-4 → CP-3b → DT-5a/b → HC-1a/b → DI-1c → DI-1a → DI-1b → CQ-LIM-1/2/3 → CQ-LIM-4 → CP-2b → CP-4 → PUB-G → DD-1 → PUB-L → E-1 → E-2

NC-1（K3/3 の実装。2026-10-18 に追加）は DA-1 の開放 commit の前に merge する（開放 commit は NC-1 の merge と G-open の後）。NC-1 は #683 で merge 済みで、開放 commit は未実施。DA-1 の ST1・ST2・ST4 と ST3 の開放の前は #676 で先に merge 済みなので、列の DA-1 を2つに分けた。CB-2 など他の lane との前後は、準備できた順に入れ替えてよい。

CQ-LIM-1〜4（proposal/7 の実装。2026-10-17 に追加）は、X1-3 の merge の後の再測を終えてから merge するので、列では DI-1b の後、CP-4 の前に置いた（実際は 2026-10-18 に #678 で merge 済み）。列は準備できた順に入れ替えてよい（下記）が、CQ-LIM-4 は CP-4 の G-03 の観測の前に終える。CQ-LIM-1〜3 の merge と CP-4 の順序は CP-4 の TASK.md を作るときに integrator が決めて記録する（proposal/7 の draft に定めがない）。X1-2／X1-3／X1-4（X1/1。2026-10-17 に確認済み）はこの列に置いていない。CB-1 と並行に作り、後に merge する側が先に入った側の試験を通す。§6 の列では CP-3a が CB-4 の前にあるが、§4 の依存は CP-3a／b に CB-4 の merge を求めるので、CP-3a の merge は CB-4 の後でよい。

2026-10-19 までの merge の実績（squash commit）:

| PR | lane | squash commit |
|---|---|---|
| #669 | DF+（K4/3 と K5/3 の確認済み契約の実装） | `e249a516b4d4b2ddda375330c62f292c9c4271c0` |
| #670 | X1-2（Scene の Scope 世代と undo journal の方式 J1） | `66890f8b35b70a8de5cb3af1f3bac7d5f6983139` |
| #671 | DT-4（local 生成 route の監査・登録・AI 使用ポリシーの検査） | `d6666ca985e4182990af74d96489725e1b3ceecf` |
| #672 | 決定の `created_at` を厳密に後にする修正（Full の揺れ。承認と取消が同じミリ秒だと取消が効かない不具合） | `1dbf6eec41b233c1adfbb637ce6333863875ba10` |
| #673 | CB-1（schema v43） | `74d9502835355053db3edede20a73412a20fc11f` |
| #674 | X1-3（型付き Revision の Scope を anchor ごとの Scene Scope 投影に） | `50a405575a7e5ccf9e6599eeb6558fe7ddc3ed50` |
| #675 | HS-1 | `cab14d995b5516f1e51896d3bd1337cf018990fd` |
| #676 | DA-1（`own-data-read` の開放 commit を除く。WebRTC の finding で止めた） | `2b68fd4df67599ca2f277fc94f94956de463381e` |
| #677 | DP-H（harness まで。evidence は HOLD。版 1 の fixture は観測により失効） | `01238cfcd2cb8b0125bc493655a4a16888b6cd57` |
| #678 | CQ-LIM-1〜4（G-03 の re-freeze は独立 reviewer の approve。`freeze.v1.json` の sha256 は `6080530adc0a7d2d45896005664f6f498d5f28c3eeed517875f8f599faa8bae7`） | `a789039a779eb4df0dec2b8b3be5e29d2bff5a5c` |
| #679 | Session B3（K3/3）の確認の記録（LEDGER-1。docs だけ） | `7c3d31106f2897016d5c146c5f1f3247a2d39f9a` |
| #680 | DT-5（local 生成の transport と、成功の監査の終端） | `5cfb38a8116d30cd60e2759cfbf24f1787d48ebe` |
| #681 | HC-1（history の再認可。`CurrentQualifier` と lineage） | `17bde2867bc1ecb3c12de085902a8d9caced1bdd` |
| #682 | CB-2（Scene 本文の宣言と取消の writer、MG-1 の grant と gate） | `739793eacfacb35320b4500b0e42969a29dcf47c` |
| #683 | NC-1（K3/3 の実装。renderer の外向き通信を Main の network 層で塞ぐ。G-open の記録は Linux の実機） | `a8ee82d5a9e339e4ddf3899fe5f23fee093e6f86` |
| #684 | DI-1c（create と claim の防御、Native の Revision 選択、取消の結束） | `b8a0bb7cd74bf51d0377169b84d694bac4bd09b1` |

master の canonical Full は `a789039a` で green だった（run 39102745768、基点 `01238cfc`）。その後、`a8ee82d5`（#683）で green（run 39150424373）。`b8a0bb7c`（#684）の Full は run 39154324262 で実行中（この記録の時点。完了の見届けは integrator）。#680〜#684 の merge の順は #681、#682、#680、#683、#684 で、PR 番号の順と違う。DT-5、HC-1、CB-2、DI-1c の4レーンの PR と NC-1 は、[nir1-lane-decisions の README](nir1-lane-decisions/README.md) の索引の衝突を避けるため、索引の行を足さずに merge し、後の docs の同期の PR（`claude/nir1-sync2`）で足した。

各 PR の手順（U4。merge の条件は U7 で変更した。CI の実態は #627 以降の hosted 実行に合わせる。規則の正本は [GDX-TRACE-001](../../policies/quality/iron-laws.md#GDX-TRACE-001)、手順は `/ship-branch`）:

1. 最新の `origin/master` に同期して freeze する（`/ship-branch` §2.3。未 push の branch は rebase し、push 済みの branch は force push の明示がなければ `origin/master` を取り込む）。`git fetch origin master` の後、最新の `origin/master` が候補 HEAD の祖先であることを確かめる。
2. 独立受入れで P2 以上を 0 にする。
3. shell-local の `candidate_base` と `candidate_head` を一度だけ解決する。Quick はローカル（`pnpm ci:local:quick` と直後の verify）か hosted（`canonical-ci.yml` の `profile=quick`）で行い、complete な Quick receipt を得る。hosted の Quick は、branch を push し、remote HEAD が `candidate_head` と一致することを確かめてから dispatch する。worker・frame・Native owner を変える PR では、同じ head に `ci.yml` の C-query opt-in lane と lifecycle lane も dispatch する。
4. 同じ head の `ci.yml` checks（opt-in lane を含む）と Quick を green にする。通常の PR のために canonical Full は dispatch しない。
5. `gh pr merge --squash --match-head-commit <candidate_head>` で merge する。merge 直前に base が `candidate_base` と一致することは要求しない。Quick の後に `origin/master` が進んでも、衝突がなく PR HEAD が `candidate_head` のままなら、同期（手順 1）と Quick はやり直さない。衝突があるか候補を変えるときは、同期して 1 からやり直す。
6. merge の後、merge commit が `origin/master` に含まれることを確かめる。squash commit の first parent が `candidate_base` と違っても失敗にしない。
7. merge した担当は、master の head で hosted の canonical Full を dispatch する。実行中なら、終わった後に最新の master head で 1 本だけ dispatch する。次の merge はこの Full の完了を待たない。dispatch した run の id は integrator へ引き継ぎ、完了の見届けと赤のときの対応の開始は integrator が行う（`/ship-branch` §8.3）。master の Full が赤になったら（判定は `/ship-branch` §8.5。全 job を再実行している間も赤のままである）、次の merge の前に、全 job の再実行で再現するか、どの merge が持ち込んだかを切り分け、修正か revert を他の PR より先に merge する。他のレーンの PR を revert するかどうかは integrator が判断する。

release PR と release tag は、従来どおり complete な hosted Full と verify を要求する（release PR は merge 前、tag は merge 後の release commit 自身）。

U5（計画外）への依存: M0（CI 保守。期限と Dependabot への対応）の master の Full が走っている間は、NIR の Full を重ねて起動せず、終わった後に最新の master head で 1 本だけ dispatch する。10-17／18 を過ぎても M0 が入らず PR の Security job が失敗する間は、merge 列を止めて実装を続け、ユーザーに報告する。master の Full の失敗は、M0 の期限切れによるものか NIR の変更によるものかを切り分ける。

## 7. worktree 台帳

作成先は `~/worktrees/Grimodex/`。root checkout（`~/Grimodex`）と Codex の worktree（`~/.codex/worktrees`）は変更しない。

| worktree | branch | base | 用途 |
|---|---|---|---|
| `claude-nir1-gov` | `claude/nir1-gov` | `a153743b` | G0 |
| `claude-nir1-cres` | `claude/nir1-cres` | `a153743b` | CR-1／CR-REC |
| `claude-nir1-cp0` | `claude/nir1-cp0` | `a153743b` | CP-0 |
| `claude-nir1-dt1` | `claude/nir1-dt1` | `a153743b` | DT-1 |
| `claude-nir1-dt2` | `claude/nir1-dt2` | `3688a063`（`claude/nir1-dt1`） | DT-2（DT-1 の上に積む） |
| `claude-nir1-dt3` | `claude/nir1-dt3` | `3688a063`（`claude/nir1-dt1`） | DT-3（DT-1 の上に積む） |
| `claude-nir1-cp1` | `claude/nir1-cp1` | `0e041537`（`claude/nir1-cres`） | CP-1（CR-1 の上に積む） |
| `claude-nir1-broute` | `claude/nir1-broute` | `a153743b`（`origin/master`） | B-ROUTE |
| `claude-nir1-hp` | `claude/nir1-hp` | `a153743b` | HP-1 |
| `claude-nir1-spike` | `claude/nir1-spike` | `a153743b` | SPIKE S1〜S6（merge しない） |
| `claude-nir1-contracts` | `claude/nir1-contracts` | `a153743b` | 契約 K1〜K6 の起案（merge しない branch で SHA を固定） |
| `claude-nir1-crrec` | `claude/nir1-crrec` | `dabbed14`（`origin/master`） | CR-REC（受入れ台帳と HOLD の解除。docs だけ） |
| `claude-nir1-cp2a` | `claude/nir1-cp2a` | `e405e80d`（`claude/nir1-dt2`）に CP-1 を cherry-pick | CP-2a |
| `claude-merge-gate` | `claude/merge-gate-quick` | `dabbed14`（`origin/master`） | U7 の merge 規則（#654） |
| `claude-nir1-cr2` | `claude/nir1-cr2` | `fbdc8588`（`origin/claude/nir1-cres`） | CR-2（C-resource の残る境界の試験） |
| `claude-ci-pin` | `claude/ci-pin-c2zc-base` | `75074118`（`origin/master`） | CI の C2-ZC の base の固定（#651） |
| `claude-flaky-sampler` | `claude/flaky-runtime-sampler-pid` | `8ff9d559`（`origin/master`） | runtime-perf の pid の flake（#652） |
| `claude-nir1-cqopt` | `claude/nir1-cqopt` | `8ff9d559`（`origin/master`） | CQ-OPT（#657） |
| `claude-journey-create` | `claude/journey-idempotent-create` | `532fd927`（`origin/master`） | journey の作成の冪等化（#653） |
| `claude-flaky-x` | `claude/flaky-x` | `254553a8`（`origin/master`） | 不安定な試験3種（#658） |
| `claude-flaky-y` | `claude/flaky-y` | `254553a8`（`origin/master`） | 回復の試験の期限（#659） |
| `claude-nir1-bguard` | `claude/nir1-bguard` | `f9680f07`（`origin/master`） | B-GUARD（#660） |
| `claude-nir1-x1a` | `claude/nir1-x1a` | `826b3c97`（`origin/master`） | X1-1（DR-X1-1） |
| `claude-nir1-cqavail` | `claude/nir1-cqavail` | `92f9badd`（`origin/master`） | CQ-AVAIL（DR-CQA-1〜3） |
| `claude-nir1-cqmem` | `claude/nir1-cqmem` | `92f9badd`（`origin/master`）に B-GUARD を cherry-pick | CQ-MEM（DR-CQM-1） |
| `claude-nir1-docrec` | `claude/nir1-docrec` | `7ec6a400`（`origin/master`） | DOC-REC（ユーザー決定の転記、worktree 台帳、判断記録の保全。docs だけ） |
| `claude-nir1-b1rec` | `claude/nir1-b1-record` | `df40eec8`（`origin/master`） | Session B1 の確認の記録（K3/2、K4/3、K5/3、K6/2、X1/1 の取り込み、確認台帳、本書。docs だけ） |
| `claude-nir1-b2rec` | `claude/nir1-b2-record` | `a7666048`（`origin/master`） | Session B2 の確認の記録（K2/4、proposal/7 と測定の記録の取り込み、確認台帳、本書。docs だけ） |
| `claude-nir1-b3-record` | `claude/nir1-b3-record` | `a789039a`（`origin/master`） | Session B3 の確認の記録（K3/3 と測定の記録の取り込み、確認台帳、本書。docs だけ） |
| `claude-nir1-measure` | `claude/nir1-measure` | `df40eec8`（`origin/master`） | proposal/7 の測定の実行（merge しない。harness は `nir1-lane-decisions/proposal7-measurement/` に取り込み済み） |
| `claude-nir1-df-plus` | `claude/nir1-df-plus` | `a7666048`（`origin/master`） | DF+（#669） |
| `claude-nir1-dt4` | `claude/nir1-dt4` | `a7666048`（`origin/master`） | DT-4（#671） |
| `claude-nir1-x1-2` | `claude/nir1-x1-2` | `a7666048`（`origin/master`） | X1-2（#670） |
| `claude-nir1-cb1` | `claude/nir1-cb1` | `a0ce11aa`（`origin/master`） | CB-1（#673） |
| `claude-nir1-cq-lim` | `claude/nir1-cq-lim` | `a0ce11aa`（`origin/master`） | CQ-LIM-1〜4（#678） |
| `claude-nir1-da1` | `claude/nir1-da1` | `a0ce11aa`（`origin/master`） | DA-1（#676。開放 commit を除く） |
| `claude-nir1-dp-h` | `claude/nir1-dp-h` | `a0ce11aa`（`origin/master`） | DP-H（#677。harness まで） |
| `claude-nir1-x1-3` | `claude/nir1-x1-3` | `e249a516`（`origin/master`） | X1-3（#674） |
| `claude-nir1-hs1` | `claude/nir1-hs1` | `e249a516`（`origin/master`） | HS-1（#675） |
| `claude-fix-graph-oversized-flake` | `claude/fix-graph-oversized-flake` | `d6666ca9`（`origin/master`） | 決定の `created_at` を厳密に後にする修正（#672） |
| `claude-nir1-webrtc-proto` | `claude/nir1-webrtc-proto` | `b99f018d`（DA-1 の ST1 の commit） | K3/3 の試作と測定（merge しない。記録は `nir1-lane-decisions/webrtc-closure-measurement/` に取り込み済み） |
| `claude-nir1-dt5` | `claude/nir1-dt5` | `01238cfc`（`origin/master`） | DT-5（#680） |
| `claude-nir1-hc1` | `claude/nir1-hc1` | `01238cfc`（`origin/master`） | HC-1（#681） |
| `claude-nir1-cb2` | `claude/nir1-cb2` | `01238cfc`（`origin/master`） | CB-2（＋MG-1。#682） |
| `claude-nir1-di1c` | `claude/nir1-di1c` | `01238cfc`（`origin/master`） | DI-1c（#684） |
| `claude-nir1-nc1` | `claude/nir1-nc1` | `7c3d3110`（`origin/master`） | NC-1（#683） |
| `claude-nir1-sync2` | `claude/nir1-sync2` | `b8a0bb7c`（`origin/master`） | #679〜#684 の後の docs の同期（README の索引と本書。docs だけ） |
| `claude-nir1-cb4` | `claude/nir1-cb4` | `b8a0bb7c`（`origin/master`） | CB-4 |
| `claude-nir1-di1a` | `claude/nir1-di1a` | `b8a0bb7c`（`origin/master`） | DI-1a |
| `claude-nir1-di1b` | `claude/nir1-di1b` | `b8a0bb7c`（`origin/master`） | DI-1b |
| `claude-nir1-x1-4` | `claude/nir1-x1-4` | `b8a0bb7c`（`origin/master`） | X1-4 |

`origin/master` の基点はいずれも `a153743b3f672b7274bdd748f15ef9c216dc9961`（#629）。`claude-nir1-dt2` は 2026-10-12 23:17 JST に、`claude/nir1-dt1` の DT-1 commit `3688a0633537818e80a88e40f056604ffa496e8a` から作った。`claude-nir1-dt3` は 2026-10-12 23:34 JST に、同じ DT-1 commit `3688a0633537818e80a88e40f056604ffa496e8a` から作った。`claude-nir1-cp1` は 2026-10-13 00:11 JST に、`claude/nir1-cres` の CR-1b commit `0e041537e8c56c43be38afea490c26857bb488a7` から作った。`claude-nir1-broute` は 2026-10-13 00:47 JST に `origin/master` の `a153743b` から作った（SPIKE S1 で、製品に B の sealed binding を publish する経路が無いことが分かったため、B-ROUTE レーンを追加した）。`claude-nir1-crrec` は 2026-10-13 22:07 JST に `origin/master` の `dabbed14711561693b0a86de0241873a9beafa04`（#649）から作り、CR-1 の merge の後に、その squash commit `750741183cf4d75ccf18b3904a5751b762284bda`（#636）へ載せ替えた。作成時刻は各 branch の reflog（`git reflog show --date=iso <branch>`）の作成記録で確かめた。以後に作る worktree は、作成時に本表へ追記する。merge 済みのレーンの worktree は、この計画で作ったものに限って片付ける。

`claude-nir1-crrec` より後の行は、DOC-REC（2026-10-14）でまとめて追記した。作成時刻（JST）は各 branch の reflog の作成記録で確かめた：`claude/nir1-cp2a` 10-13 22:13、`claude/merge-gate-quick` 22:27、`claude/nir1-cr2` 23:03、`claude/ci-pin-c2zc-base` 23:34、`claude/flaky-runtime-sampler-pid` 10-14 01:47、`claude/nir1-cqopt` 02:13、`claude/journey-idempotent-create` 02:23、`claude/flaky-x` と `claude/flaky-y` 04:34、`claude/nir1-bguard` 10:13、`claude/nir1-x1a` 12:20、`claude/nir1-cqavail` と `claude/nir1-cqmem` 12:36、`claude/nir1-docrec` 14:10。

2026-10-14 に、merge 済みのレーンの worktree を片付けた。対象は、HEAD が merge 済みの PR の head と一致し、追跡されるファイルに未 commit の変更が無いものに限った。12:25 に `claude-ci-pin`、`claude-flaky-sampler`、`claude-flaky-x`、`claude-journey-create`、`claude-merge-gate`、`claude-nir1-broute`、`claude-nir1-cp0`、`claude-nir1-cp1`、`claude-nir1-cp2a`、`claude-nir1-cr2`、`claude-nir1-cres`、`claude-nir1-crrec`、`claude-nir1-dt1`、`claude-nir1-dt2`、`claude-nir1-dt3`、`claude-nir1-hp` を、13:17 に `claude-flaky-y` と `claude-nir1-cqopt` を片付けた（時刻は会話記録の timestamp）。branch は残した。このとき、gitignore の対象（`.ralph/`）に置かれていた lane の判断記録（DT-1、DT-2、DT-3、CR-1、HP-1、CP-1、B-ROUTE の `.ralph/agent/decisions.md`）も一緒に消えた。消えた記録は会話記録から復元し、§3.3 の記録先に置いた。以後は、worktree を片付ける前に `git status --porcelain --ignored` で ignore 対象を確かめ、記録を退避してから消す。

`claude-nir1-b3-record` より後の行は、docs の同期（`claude/nir1-sync2`。2026-10-19）でまとめて追記した。作成時刻（JST）は各 branch の reflog の作成記録で確かめた：`claude/nir1-measure` 10-17 12:08、`claude/nir1-df-plus`・`claude/nir1-dt4`・`claude/nir1-x1-2` 14:31、`claude/nir1-cb1`・`claude/nir1-cq-lim`・`claude/nir1-da1`・`claude/nir1-dp-h` 19:18、`claude/nir1-x1-3`・`claude/nir1-hs1` 20:31、`claude/fix-graph-oversized-flake` 22:51、`claude/nir1-webrtc-proto` 10-18 02:08、`claude/nir1-dt5`・`claude/nir1-hc1`・`claude/nir1-cb2`・`claude/nir1-di1c` 13:01、`claude/nir1-nc1` 19:24、`claude/nir1-sync2` 10-19 03:29、`claude/nir1-cb4`・`claude/nir1-di1a`・`claude/nir1-di1b`・`claude/nir1-x1-4` 03:30。U5（CI 保守。計画外）の worktree は載せない。merge 済みのレーンの worktree は、この時点ではまだ片付けていない。

## 8. 2026-09-25/26 の off-master 承認と WIP（不採用・参照のみ）

- U1 により採用しない。master の確認台帳には記録せず、承認の根拠にも文面の流用元にもしない。
- 対象は Codex worktree に残る未 commit の draft と WIP で、基点は `689261c3`（#609）。worktree は `nir1-c-body-contract-draft`、`nir1-d-history-contract-draft`、`nir1-d-local-send-contract`、`nir1-d-startup-barrier-contract`、`nir1-goal-baseline` の5つ。
- 参照のため、tracked diff と untracked ファイルを integrator の scratchpad へ凍結コピーし、SHA-256 を記録した（`SHA256SUMS` 自体の SHA-256 は `f8c0d27560862530fee558bffc23bab91564850b475e4ce39d3a874e4a160d19`）。repo には取り込まない。
- WIP から移植するコードは新しい候補として扱い、最新 master 上で再試験・再レビューする。旧 review 証跡は流用しない。
- 旧 C-body・history の draft（master 上の `nir1-c-target-scene-body-authority-proposal-draft.md`、`nir1-c-scene-body-disclosure-delta-draft.md`、`nir1-d2b-history-authority-proposal-draft.md`）は superseded とし、後継は K2 と K4 とする。

## 9. 停止点

1. Session A（D+0〜1）: K1 の2文。2026-10-12 に確認された（§10.1）。
2. Session B（D+3〜5、準備できた行から）: K2〜K6 と各選択肢。委任判断の一覧も通知する。2026-10-17 の Session B1 で K3〜K6 と X1 を確認し（§10.3）、同日の Session B2 で K2/4 と proposal/7 を確認し（§10.4）、2026-10-18 の Session B3 で K3/3 を確認した（§10.5）。
3. 条件付き（起きたときだけ止める）:
   - S1 が期待と違ったとき。C-body に投資する前に G-01 の評価改訂を確認してもらう。
   - D の窓に届かないとき。graph-eval-procedure を確認してもらうか HOLD にする。D を広げるのは閾値の緩和にあたる。
   - 上限を緩める必要が出たとき、または委任外に当たったとき。
   - M0 の見込みが 10-16 になっても立たないとき（報告）。
4. Session C-1: PUB-G と D2a の UI の承認。Session C-2: PUB-L の承認（consent の文言、listener 置換）。
5. E の完了時の報告。

## 10. 確認セッションの記録

### 10.1. Session A（K1）

| 項目 | 値 |
|---|---|
| 受信 | 2026-10-12T23:58+0900。integrator セッション（`3754f9a7-620d-4e21-ad37-3096691a96be`）での、ユーザー自身が打ったメッセージ |
| draft | `claude/nir1-contracts` の commit `ba7ceb46306ec48383a70e52951288ed8c7e960b` の `docs/plans/nir1-l6-l9-contract-proposal-6-draft.md` |
| draft の SHA-256 | `5528f4e091ca087c0f1e071039c6bcede9d3d7cde1422ac1bfd852ee1d8d6b4b` |
| 取り込み | byte 同一で [proposal/6 draft](nir1-l6-l9-contract-proposal-6-draft.md) として取り込み、`sha256sum` が上の値と一致することを確かめた。「Status: draft／未確認」の行を含めて本文は編集せず、確認状態は確認台帳で表す |

ユーザーが打った2文（逐語）:

```text
I confirm draftRef nir1-l6-l9-contract-proposal/6 for contractId graph-limited-binding.
I confirm draftRef nir1-l6-l9-contract-proposal/6 for contractId nir1-defensive-resource-limits.
```

- 1文目は `graph-limited-binding` の行だけを、2文目は `nir1-defensive-resource-limits` の行だけを確認する（確認台帳の Confirmation protocol）。
- 記録先は [L6〜L9実行計画](nir1-l6-l9-execution-plan.md) の確認台帳。`graph-limited-binding` の行を proposal/6 にし、`nir1-defensive-resource-limits` の行を加えた。proposal/5 の節と L7 の resource unit 表は、確認時点（`13e3f6c6^`）の文面に戻して履歴とし、proposal/6 の節を加えた。proposal/5 の確認の記録は、台帳の説明文に履歴として残した。
- 残HOLD表の「Revision上限の整合」は、解消（K1 確認）とした。C-resource の受入れの HOLD は、CR-REC（CR-1 の lane 証跡と独立受入れ）で解除するので、まだ解除しない。
- `graph-query-memory-accounting/1` は proposal/6 で退役した。[C-query 資源・lifecycle 境界](nir1-c-query-memory-enforcement-v1-draft.md) と [C-query Linux resource probe](nir1-c-query-linux-resource-probe-draft.md) に注記した。
- この確認は、Graph の製品公開、local 送信、新しい authority・保存先・送信先、K2〜K6 の内容を確認しない。

### 10.2. CR-REC（C-resource の受入れ）

CR-1（#636）の lane 証跡と独立受入れを、[C-query 受入れ台帳](nir1-c-query-acceptance-2026-10.md) に束縛した。docs だけの変更で、新しい委任判断（§3.2）は発生しない。

| 項目 | 値 |
|---|---|
| 記録日 | 2026-10-13 |
| 解除した範囲 | 台帳の §2 で「充足」とした条件（CQ-1〜3、RB-3、RB-5〜RB-7、LC-1〜LC-9、NB-1、PF-1、A-1）と、「一部充足」の行のうち試験がある部分 |
| 解除の条件 | CR-1（#636）の merge と、最終 head の Quick・PR checks・lane 6本の green。いずれも満たした（CR-1 の squash commit：750741183cf4d75ccf18b3904a5751b762284bda）。CR-1 は 2026-10-13T14:06:23Z に merge された。U7（2026-10-13 のユーザー決定）により Full は merge 後の master で走らせる。最終 head の結果は台帳の §3.2、§3.3、§4 に記入した |
| U7 の記録 | U7（2026-10-13 のユーザー決定）の逐語の記録と、規則文書の更新は別の PR で行う。本節は参照するだけである |
| 残す HOLD | 台帳の §7 の G-1〜G-4（Revision と per-Revision preflight の境界、DB の SQLITE_BUSY、proposal/5 の負例の一部）。CR-1 の試験では固定されていない境界で、後続の CR-2（branch `claude/nir1-cr2`、試験だけの PR、進行中）で足してから解除する |
| 変えないもの | 製品の Graph 入口（A-1）、Graph の公開、local 送信、固定値と閾値、確認台帳の各行、K2〜K6 の内容 |
| 試験の期待値 | `scripts/quality/quality-workflow.test.mjs` の、L6〜L9実行計画の残HOLD表で C-resource の行を固定する assertion は、CR-REC までは HOLD を守る番人だったため、解除済みの形に更新した。確認台帳の `graph-limited-binding` の行を固定する assertion は文言を残し、括弧書きで追記しただけで、変えていない。各文書の解除の記述が、解除の条件（CR-1 の merge と、最終 head の Quick・PR checks・lane 6本の green）、squash commit の SHA、U7 の文言を持つことは、同じ試験で固定した |

### 10.3. Session B1（K3/2、K4/3、K5/3、K6/2、X1/1）

| 項目 | 値 |
|---|---|
| 受信 | 2026-10-17（JST、Session B1）。integrator セッション（`fa34d6ef-ff00-4f4d-846d-7ccee58abf30`）での、ユーザー自身が打ったメッセージ。最初のメッセージで8文、9文目（X1/1 の `typed-revision-material`）は、最初の送信が無効だったため、同日に入力し直したメッセージで届いた |
| 確認された版 | `claude/nir1-contracts` の commit `af643a93eeae7f937c9cd5a9dd87a6308c96fab6`（push 済み。repository activity の server 側の時刻 2026-10-17T02:13:10Z）の `docs/plans/<file>`。版の一覧は [manifest](nir1-session-b1-manifest.md) |
| 取り込み | 5本の draft と、draft が引く設計メモ（[DSN](nir1-dsn-2026-10.md)。確認の対象ではない）と manifest を、byte 同一で取り込み、`sha256sum` が manifest の値と一致することを確かめた。「Status: draft／未確認」の行を含めて本文は編集せず、確認状態は確認台帳で表す |

draft の SHA-256:

| 略称 | ファイル | SHA-256 |
|---|---|---|
| K3/2 | [nir1-d2a-activation-proposal-2-draft.md](nir1-d2a-activation-proposal-2-draft.md) | `a16e8b259f8b58e53152e5bb2e503f3cf995f979d85bf4922ccd420f6bf5fd30` |
| K4/3 | [nir1-d2b-history-mapping-proposal-3-draft.md](nir1-d2b-history-mapping-proposal-3-draft.md) | `f6a189371b4d793c0c440d2ee1d0c96d66c60069d35fa95d31e5c971701a99d7` |
| K5/3 | [nir1-d2b-local-send-proposal-3-draft.md](nir1-d2b-local-send-proposal-3-draft.md) | `5a8962cd9aa5525046349b31af825c4637dc152e2bb1c5d348fc2bc8fb576723` |
| K6/2 | [nir1-final-request-eval-proposal-2-draft.md](nir1-final-request-eval-proposal-2-draft.md) | `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8` |
| X1/1 | [nir1-scene-scope-projection-proposal-1-draft.md](nir1-scene-scope-projection-proposal-1-draft.md) | `a2d85d92f4f737405922c5fefbe9acf732a8d784a27c6a2f79894c6278dc6c5e` |
| DSN | [nir1-dsn-2026-10.md](nir1-dsn-2026-10.md) | `10eb61d21d6edc5d9b0bab1c80055e364ec40c9ad4e9e4a45495d76a11f304d5` |

ユーザーが打った9文（逐語。各 draft の「確認文」と1字違わない）:

```text
I confirm draftRef nir1-d2a-activation-proposal/2 for contractId caller-profile-egress.
I confirm draftRef nir1-d2b-history-mapping-proposal/3 for contractId history-reauthorization.
I confirm draftRef nir1-d2b-local-send-proposal/3 for contractId nir1-local-product-send.
I confirm draftRef nir1-d2b-local-send-proposal/3 for contractId caller-profile-egress.
I confirm draftRef nir1-final-request-eval-proposal/2 for contractId nir1-final-request-packing-eval.
I confirm draftRef nir1-final-request-eval-proposal/2 for contractId g01-eval-revision.
I confirm draftRef nir1-final-request-eval-proposal/2 for contractId graph-eval-procedure.
I confirm draftRef nir1-scene-scope-projection-proposal/1 for contractId scope-storage-authority.
I confirm draftRef nir1-scene-scope-projection-proposal/1 for contractId typed-revision-material.
```

- 1〜8文目は最初のメッセージで届いた。9文目は、最初の送信では文中の空白（`contractId` と `typed-revision-material.` のあいだ）の位置が改行になって届き、exact statement と1字違うので確認として記録しなかった（無効）。ユーザーが同日に1行で入力し直した文を、9文目の確認とした。それ以前の「全て確認しました」という包括的な返答と、途中で切れた貼り付けも、確認として扱っていない。
- 各文は、その contractId の行だけを確認する（確認台帳の Confirmation protocol）。依存する契約は確認されない。記録先は [L6〜L9実行計画](nir1-l6-l9-execution-plan.md) の確認台帳（2026-10-17補足と各行）。proposal/3、proposal/4、proposal/6 の既存の ref は消さず、置き換えていない。
- K6/2 の条件付きの2行（`g01-eval-revision`、`graph-eval-procedure`）は、draft の「確認の扱い」が、条件が成立したときだけ判定に使った receipt を添えて確認を求める、と定めていたのに、条件の成立前にユーザーが確認文を入力した。台帳には、事前の確認（条件は未成立）。行の内容は条件が成立するまで効かず、条件が成立したときの receipt の照合（事前登録の凍結の照合3）は integrator が行う、と記録した。receipt の照合は省かない。効力の発生条件は1通りに揃えた。条件が成立して照合3が済んだら、integrator が receipt（と診断）と照合の結果を添えて利用者へ改めて確認を求め、その確認文が記録された後に限って行の内容が効く。事前の確認は、利用者が規則の内容を読んで確認文を入力した記録として残るが、効力の根拠にも、条件成立時の確認の代わりにもしない。台帳の2行は `confirmedRef` を持たず、`preConfirmationRef` で表す。
- K6/2 の事前登録の凍結: 凍結の commit は `af643a93eeae7f937c9cd5a9dd87a6308c96fab6`、K6/2 の SHA-256 は上の表の値。`git ls-remote origin refs/heads/claude/nir1-contracts` の出力は `af643a93eeae7f937c9cd5a9dd87a6308c96fab6 refs/heads/claude/nir1-contracts`。push の時刻は、自己申告が 2026-10-17 11:13 JST（commit の author／committer 時刻 11:13:09 +0900）、repository activity の server 側の時刻が 2026-10-17T02:13:10Z。PushEvent は取り直した（2026-10-17T03:21Z ごろ）が現れていない（events API の遅れ）。条件を判定する前に取り直して書く。
- この確認は、Graph の製品公開、local 送信の公開、activation UI の公開、新しい authority・保存先・送信先を確認しない。K2/4 は未確認で、Session B2 で示す。PUB-G は Session C-1、PUB-L は Session C-2 で別に承認を得る。
- lane の TASK.md への写し、DSN の改訂、規約・privacy の改訂、ADR009 の doc-sync、CR-2 の境界試験の fixture の再計算などは、lane の開始時か PR の中で行う。確認台帳の lane snapshot の追記に lane ごとに書いた。この記録の PR では行わない。

### 10.4. Session B2（K2/4、proposal/7）

| 項目 | 値 |
|---|---|
| 受信 | 2026-10-17（JST、Session B2）。integrator セッション（`fa34d6ef-ff00-4f4d-846d-7ccee58abf30`）での、ユーザー自身が打ったメッセージ。3文は1つのメッセージで届いた |
| 確認された版 | `claude/nir1-contracts` の commit `40d10adff87e19fcb364b624a1b422ba4890b3e0`（push 済み）の `docs/plans/<file>`。版の一覧は [manifest](nir1-session-b2-manifest.md) |
| 取り込み | 2本の draft と、proposal/7 の測定の記録（[`nir1-lane-decisions/proposal7-measurement/`](nir1-lane-decisions/proposal7-measurement/measurement-record.md)。`harness/`、`raw.tar.gz`、`SHA256SUMS` を含む）と manifest を、byte 同一で取り込み、`sha256sum` が manifest の値と一致することを確かめた。測定の記録は `SHA256SUMS` で検査した（`sha256sum -c` が全件通る）。「Status: draft／未確認」の行を含めて本文は編集せず、確認状態は確認台帳で表す |
| 切れたままの link | 取り込んだ K2/4 が引く K2/3（`nir1-c-body-disclosure-proposal-3-draft.md`）は確認されておらず、取り込まないので、その link は切れたまま残る（bytes を変えない） |

draft と測定の記録の SHA-256:

| 略称 | ファイル | SHA-256 |
|---|---|---|
| K2/4 | [nir1-c-body-disclosure-proposal-4-draft.md](nir1-c-body-disclosure-proposal-4-draft.md) | `efc30cca32f2c91386baf3061836427ae7df3499c18188d31b5e2ba422a2fcfd` |
| proposal/7 | [nir1-l6-l9-contract-proposal-7-draft.md](nir1-l6-l9-contract-proposal-7-draft.md) | `13fb0e6d410dbf073b219b9c1e384bfdc57239ac331434c6fe45aa0dad3aca29` |
| 測定の記録の `SHA256SUMS` | `nir1-lane-decisions/proposal7-measurement/SHA256SUMS` | `be8734432396fbbc98c7e6303e6edfbbd26f0c3a0735fd7ba59e11a16f1aeac6` |

ユーザーが打った3文（逐語。各 draft の「確認文」と1字違わない）:

```text
I confirm draftRef nir1-c-body-disclosure-proposal/4 for contractId graph-target-scene-body-disclosure.
I confirm draftRef nir1-c-body-disclosure-proposal/4 for contractId scope-storage-authority.
I confirm draftRef nir1-l6-l9-contract-proposal/7 for contractId graph-limited-binding.
```

- 各文は、その contractId の行だけを確認する（確認台帳の Confirmation protocol）。依存する契約は確認されない。K2/4 の `scope-storage-authority` の文は X1/1 の同じ contractId の文を確認せず、X1/1 の文は K2/4 の文を確認しない（互いを前提にしない）。`nir1-defensive-resource-limits` は proposal/7 が規則を変えないので確認文がなく、proposal/6 の確認が有効なまま残る。記録先は [L6〜L9実行計画](nir1-l6-l9-execution-plan.md) の確認台帳（2026-10-17補足〔Session B2〕と各行）。proposal/3、proposal/4、proposal/6、X1/1 などの既存の ref は消さず、置き換えていない。
- 確認文は各 draft の推奨の組を確認する。K2/4 は K2-1 Option B（作者が本文全体を宣言する）、K2-2 2文とも、K2-3 取消の入口に grant を要さない。proposal/7 は P7-1 時間 `100 ms` を残す、P7-2 案4（Q `16 MiB`、Native 領域 `3 MiB`、registration の検査）、P7-3 RB-1 の検査を足す、P7-4 G-03 の fixture の作り直し。推奨と違う選択は新しい draftRef で、確認していない。Option A は選ばれていないので、`g01-eval-revision` の指標の変更の新しい draftRef は起案しない。
- proposal/7 の条件: 確認文は、X1/1 の Q7（実測を X1-3 の入った候補で取る）をこの実測が満たさないことを承知した確認として扱う。proposal/7 の実装（CQ-LIM-1〜4）は、X1-3 の merge の後の再測（`harness/` の手順で表 A と表 C、RB-1 の閾値）を終えるまで merge しない。再測で、records・steps・Entity・edge・pages のどれかの余裕が 1.5 倍を割る、50場面の seed が available でなくなる、registration の使用量が Q の 85% を超える、frame が上限の 85% を超える、RB-1 の閾値が確認時の説明と合わなくなる、のどれかなら、その lane は `[precheck]` で止まり、報告し、新しい draftRef（proposal/8）を求める。時間は `100 ms` のままなので、50場面の主人公級は実装の後も拒否されうる。registration の検査の効果は未測定で、実装後の試験で確かめる。G-03 の期待値の更新は、作り直した fixture が Graph の観測の前に新しい freeze と独立レビューを経ることを条件に確認された。
- この確認は、Graph の製品公開、local 送信の公開、activation UI の公開、新しい authority・保存先・送信先の公開を許可しない。K2/4 の宣言の入口と取消の入口は PUB-G まで Native の gate で閉じる。PUB-G は Session C-1、PUB-L は Session C-2 で別に承認を得る。K6/2 の条件付きの2行は、この確認で変わらず、条件未成立のままである。
- K2/4 の確認後の記録のうち、この PR で行ったもの: 確認台帳への3行（と `nir1-defensive-resource-limits` の注記の行）と読み方の注、lane snapshot の追記、残 HOLD 表の C-body の行の更新、master 上の旧 draft 2本への superseded の注記、本書の更新。proposal/7 の確認後の記録のうち、この PR で行ったもの: 確認台帳の行と proposal/6 の節への追記、残 HOLD 表の G-1／G-2 の行への注記。proposal/6 の節と表は履歴として残し、書き換えていない。
- lane の TASK.md への写し、DSN の改訂、受入れ台帳（RB-1、RB-2、G-1、G-2）の更新、512／100,000／12／144 を期待値に持つ試験の同期、`evals/nir1-graph` の同期（CQ-LIM-4）、K3/2・K4/3・K6/2 への申し送りの扱いは、lane の開始時か PR の中で行う。確認台帳の lane snapshot の追記（Session B2）に lane ごとに書いた。この記録の PR では行わない。

Session B2 の後の lane の開始条件（契約の上での待ち。実装前の lane はどれも HOLD のまま）:

| lane | 開始 | merge の条件と依存 |
|---|---|---|
| CB-1 | 着手できる（K2/4 の2文。DT-3 と CP-1 は master） | LEDGER-1（この PR）の merge の後。X1-2／X1-3 とは、後に merge する側が先に入った側の試験を通す |
| CB-2（MG-1 を含む） | CB-1 の merge の後 | DT-1〜3 は master。高リスクの PR。mutation の前に有限の owner/lifecycle matrix を記録 |
| CB-3 | CB-2 と並行して作れる | CB-2 の後に merge |
| CB-4 | CB-1 と CP-1（master）の後に作る | CB-2 の後に merge |
| DA-2 | DA-1 の merge、MG-1（CB-2）の merge、CP-3a の merge の後 | UI と開示の公開は Session C-1 |
| CP-3a／b | CP-2a（master）、CB-4 の merge、DA-1 の merge の後 | CP-3a は §6 の列で CB-4 の前にあるが、CB-4 の merge を待つ |
| CP-4 | CP-3a／b の merge の後 | X1-2 と X1-3 の merge、CQ-LIM-4 の完了（G-03 の観測の前）、観測前の commit（Graph arm の最初の観測の前）、B-ROUTE による B の sealed binding（master）、計測窓 |
| CQ-LIM-1〜4 | 着手できる（X1-3 と並行してよい） | X1-3 の merge の後の再測を終えてから merge。CQ-LIM-4 は CP-4 の観測前の commit の前に終える |
| PUB-G | Session C-1 の承認の後 | CP-4、CP-2b、DA-2、A3＋B＋C＋D2a、CQ-LIM-1〜4 の実装（見込み） |

### 10.5. Session B3（K3/3）

| 項目 | 値 |
|---|---|
| 受信 | 2026-10-18（JST 18:25、Session B3）。integrator セッション（`fa34d6ef-ff00-4f4d-846d-7ccee58abf30`）での、ユーザー自身が打ったメッセージ。1文だけのメッセージで、draft の「確認文」の節の文と1字違わないことを機械的に照合した |
| 確認された版 | `claude/nir1-contracts` の commit `14141248f09a97945eb5620cf1190d54dc7558e8`（push 済み）の `docs/plans/<file>`。版の一覧は [manifest](nir1-session-b3-manifest.md) |
| 取り込み | draft と、測定の記録（[`nir1-lane-decisions/webrtc-closure-measurement/`](nir1-lane-decisions/webrtc-closure-measurement/measurement-record.md)。`harness/`、`records/`、`SHA256SUMS` を含む131 file）と manifest を、byte 同一で取り込み（blob の hash が commit `14141248` の tree と一致）、draft と manifest の `sha256sum` が manifest の値と一致することを確かめた。測定の記録は `SHA256SUMS` で検査した（`LC_ALL=C sha256sum -c SHA256SUMS` が130件すべて OK）。「Status: draft／未確認」の行を含めて本文は編集せず、確認状態は確認台帳で表す |
| 確認の前の経緯 | DA-1 の ST1 の Y-1 の試走が、renderer からの WebRTC の外向き接続を見つけ、`own-data-read` の開放 commit を `[precheck]` で止めた。ユーザーは 2026-10-18 に案1（構造的に塞ぐ設計を起案する）を選んだ（§1 の SB-6。確認文ではない）。K3/3 はその設計を Linux の実機で検証して起案した |
| 切れたままの link | 取り込んだ K3/3 に、取り込んでいない file への link はない。K3/3 が baseline として引く K3/2（`nir1-d2a-activation-proposal-2-draft.md`）は Session B1 で取り込み済みで、bytes は変えていない。K3/2 自身が引く K3/1 などの切れた link は、bytes を変えないので残す |

draft と測定の記録の SHA-256:

| 略称 | ファイル | SHA-256 |
|---|---|---|
| K3/3 | [nir1-d2a-activation-proposal-3-draft.md](nir1-d2a-activation-proposal-3-draft.md)（432行） | `e5362f3e40e662781d57c46d20db617aded3c7d4cf72912c0d27991b0dbded11` |
| 測定の記録の `SHA256SUMS` | `nir1-lane-decisions/webrtc-closure-measurement/SHA256SUMS`（130件） | `4ac3cc8a68d54ed5fe13b9b55ab4631174a5a01b87a9257dadb8ec561468f144` |
| K3/2（参考。変えない） | [nir1-d2a-activation-proposal-2-draft.md](nir1-d2a-activation-proposal-2-draft.md) | `a16e8b259f8b58e53152e5bb2e503f3cf995f979d85bf4922ccd420f6bf5fd30` |

ユーザーが打った1文（逐語。draft の「確認文」と1字違わない）:

```text
I confirm draftRef nir1-d2a-activation-proposal/3 for contractId caller-profile-egress.
```

- この文は、`caller-profile-egress` の行だけを確認する（確認台帳の Confirmation protocol）。確認されるのは、draft 冒頭の「ユーザーが批准すること」の1〜9だけである（範囲の正本。台帳は別の列挙を持たない）。依存する契約（K2、K4、K5、K6、`graph-limited-binding`、`nir1-defensive-resource-limits`）は確認されない。contractId は `caller-profile-egress`（K3/2と同じ。`nir1-l6-l9-contract-proposal/7` が確認済みの `/6` の一部を同じ contractId の新しい draftRef で改訂した前例と同じ形）。記録先は [L6〜L9実行計画](nir1-l6-l9-execution-plan.md) の確認台帳（2026-10-18補足〔Session B3〕と `caller-profile-egress` の行）。`nir1-l6-l9-contract-proposal/3`、`nir1-d2a-activation-proposal/2`、`nir1-d2b-local-send-proposal/3` の既存の ref は消さず、置き換えていない。
- 確認文は draft の推奨の組を確認する（NC-1、AL-0、RS-1、LS-1、MD-1、FC-1、unrestricted の挙動への影響の13項目、ゲート表、変える点の1〜9）。推奨と違う案（辞書を残す案、開示して受け入れる案、O-2 をやめる案など）は確認していない。変える点の1・6・9は K3/2 の文面より弱い読み、4は K3/2 の X-1 と異なる読みで、いずれも批准の対象だった。確認台帳に、読み替える語句を superseded の注として足した（先の注記は消していない）。
- 許可しないもの: `own-data-read` を有効にする commit（DA-1 の ST3 の開放 commit）そのもの。PUB-G と Session C-1 の承認（Graph の公開、activation UI の公開、開示の文言）。local 送信（PUB-L）。許可先や名前解決を許す名前の追加、閉じた集合の外の新しい network 設定、閉じ込めを止める入口、新しい authority・保存先・送信先。K3/3 は、開放の前提（Y-1 の外向きが0）を成立させる設計を確定するだけで、開放の許可の出所は K3/2 の O-2 の確認のままである。K6/2 の条件付きの2行は、この確認で変わらず、条件未成立のままである。
- ゲート（K3/3 の draft のゲート表が正本）: G-open は `own-data-read` を開放する commit（DA-1 の ST3。Linux の最終候補）の条件、G-pub は PUB-G（3 OS の packaged smoke。CP-2b）の条件。release／tag は縛らない。NC-1 は未実装で、G-open も G-pub も通っていない。
- この PR で行ったこと: K3/3 の draft、測定の記録、manifest の取り込み。確認台帳の2026-10-18補足、`caller-profile-egress` の行（K3/2 の行と並べて。K3/2 の行は消していない）、読み替える語句の superseded の注、「3つの ref は加算」への例外の注記、残 HOLD 表の D2a と Graph の公開（PUB-G）の行の更新、lane snapshot の追記。本書の更新（§1 の SB-6 と SB-7、§2.1、§3.2、§4、§6、§7、§9、本節、§11）。`nir1-lane-decisions/README.md` への測定の記録の行。
- この PR で行わないこと: NC-1 の実装、`own-data-read` の開放、G-open と G-pub の実行、PUB-G と Session C-1 の承認。lane の TASK.md への写し、DSN の renderer の隔離と起動の順序の記述の改訂、DA-1 の判断の記録（`da1-decisions.md`）への K3/3 の写しと、DNS 先読み・preconnect を「0件」とした記述の訂正、`RECORDED_Y1_COUNTERMEASURES` と `OPEN_FINDINGS` の更新、owner／lifecycle matrix への行の追加は、NC-1 の lane の開始時か PR の中で行う。K3/2 の「続く通信」の開示に無かったことの Session C-1 の開示の材料への写しも、C-1 の準備で行う。AGENTS.md と `.agents/skills` は編集しない。

Session B3 の後の lane の開始条件（契約の上での待ち。実装前の lane はどれも HOLD のまま）:

| lane | 開始 | merge の条件と依存 |
|---|---|---|
| NC-1 | 着手できる（K3/3 の確認。DA-1 の ST1 は #676 で master） | DA-1 の開放 commit（ST3）の前に merge。mutation の前に有限の owner/lifecycle matrix を記録（GDX-PRECHECK-001）。G-open（Linux の実機の再走）が最終候補で通ること。工数は約7日（推定） |
| DA-1 の開放 commit（ST3） | NC-1 の merge の後 | G-open の通過（K3/3 のゲート表）。開放は未実装。公開は PUB-G と Session C-1 の別の承認 |
| DA-2 | DA-1 の merge、MG-1（CB-2）の merge、CP-3a の merge の後 | NC-1 は DA-2 と独立。起動の順序（NC-1 が default session の最初の接触で `initBackend` より前）だけが加わる。UI と開示の公開は Session C-1 |
| CP-2b | audit 例外の扱いは §4 のとおり | 3 OS の packaged smoke に Negative (34) を加える（G-pub）。観測の道具の方式は着手時に決める |
| PUB-G | Session C-1 の承認の後 | CP-4、CP-2b、DA-2、A3＋B＋C＋D2a、G-pub（3 OS の packaged smoke で Negative (34)）。CQ-LIM-1〜4 は #678 で master |
| DD-1 | K6 の確認者が、K6/2 の DD-1 の分類と K3/3 が加えた「続く通信」の2項目の両立を判断した後（K3/3 の引き継ぎ H4。契約の条件ではない integrator の運用） | 両立しなければ K6 の新しい draftRef を起案する |

2026-10-19 追記（#679〜#684 の merge の後。上の記録と表は直さない）:

- Session B3 の記録は #679（`7c3d3110`）で master に入った。
- NC-1 は #683（`a8ee82d5`）で master に入った。判断の記録は [nc1-decisions.md](nir1-lane-decisions/nc1-decisions.md)（DR-NC1-1〜49）。G-open の記録は Linux の実機で採った（[`nir1-lane-decisions/nc1-g-open/`](nir1-lane-decisions/nc1-g-open/README.md)。採取時の head は `fd549d4c`、Electron 43.5.0）。Windows／macOS と packaged の build は G-pub（CP-2b）の範囲で、この記録に含まない。採取時の head の製品コードと harness が master と同一であることは、PR の時に git diff で確かめた。この同期で `fd549d4c` と `b8a0bb7c` の差を見直した結果: NC-1 の module（`electron/main/rendererContainment*.ts`。試験を除く）と harness（`electron/scripts/webrtc-block-probe*`）には差が無い。ただし `electron/main` の全体では、NC-1 より先に merge した CB-2（#682）の MG-1 の配線（`index.ts`、`ipc.ts`、`mainGrant.ts`、`bodyDeclarationCiSeam.ts`、`profileEgress.ts`）とその試験の差がある。DR-NC1-46 (b) の検査（`git diff <記録の head> HEAD -- electron/main electron/scripts/webrtc-block-probe*` が空）は字義のままでは満たさないので、この差の扱い（再走するか、閉じ込めに影響しないことを確かめるか）を開放 commit の PR で決める。
- DA-1 の開放 commit（ST3。`own-data-read` を有効にする commit）の前提は、NC-1 の merge、G-open の記録、master の canonical Full の green である。NC-1 の merge と G-open の記録は満たした。master の Full は `a8ee82d5` まで green（run 39150424373）で、`b8a0bb7c` の Full（run 39154324262）は実行中（この記録の時点）。開放 commit は未実施で、実施の前にユーザーの確認を得る。開放の後も、PUB-G と Session C-1（Graph の公開、activation UI の公開、開示の文言）は別の承認である。

## 11. 未解決事項

- `[precheck]` DT-2 の再試行の上限（sweep の recover の再試行 0 回→最大2回、送信していない終端の書込みの再試行 1 回→最大3回。K1b の規則7の再確認の対象）の再確認は、Session B1 の9文のどれにも含まれず、未解決である。手段は DSN §9 のとおり（新しい draftRef を起案するか、1件1回への締め直し）。台帳の残 HOLD 表の D-transport の行（DT-1〜3）からここへ向ける。
- `[policy]` `.agents/skills/bump-version/SKILL.md` の手順9（97行目）は、release commit の Full に、ローカルの `pnpm ci:local:full -- --base "$release_base" --head "$release_head"` を指示したままである。Full admission が標準の GitHub-hosted job 以外を拒否するとした更新後の [GDX-TRACE-001](../../policies/quality/iron-laws.md#GDX-TRACE-001) と食い違う。release flow は G0 の範囲外（U5 の CI 保守に近い）なので、G0 では skill を編集しない。次の release の前に、hosted の canonical Full への読み替えを別に扱う。
- proposal/7 の実装（CQ-LIM-1〜4）の merge 条件（X1-3 の merge の後の再測を終えること）は、2026-10-18 に満たされた。最初の再測が §10.4 の条件（registration の使用量が Q の 85% を超える）を割って `[precheck]` で止まり、ユーザーが「まず実装で直す（推奨）」を選んで（§1 の SB-7）実装で解消し（DR-CQL-13）、proposal/8 は不要だった。CQ-LIM-1〜4 は #678 で master にある。
- CQ-LIM-1〜3 の merge と CP-4 の順序は、proposal/7 の draft に定めがなかった。CQ-LIM-1〜4 は CP-4 の前に #678 で merge 済みで、CQ-LIM-4（G-03 の再 freeze）も済んだ。CP-4 の TASK.md を作るときに、観測前の commit が引く freeze の sha256（`6080530adc0a7d2d45896005664f6f498d5f28c3eeed517875f8f599faa8bae7`）を確かめる。
- 取り込んだ K2/4 の K2/3 への link は切れたままである（bytes を変えない）。
- `[precheck]` DA-1 の ST3 の開放 commit（`own-data-read` を有効にする commit）は、K3/3 の確認で設計が確定し、NC-1 は #683 で master に入り、G-open の記録（Linux の実機）もある。開放 commit は未実施で、実施の前にユーザーの確認を得る。G-open の記録の head と master の `electron/main` の差（CB-2 の MG-1 の配線）の扱いは、開放 commit の PR で決める（§10.5 の 2026-10-19 追記）。
- K3/3 の引き継ぎ H4: K6/2 の DD-1 の分類が、K3/3 が「続く通信」に加えた2項目（Chromium から LS-1 への接続と、blackhole された辞書の要求の試み）を「一覧の項目への試み」として扱えるか、K6/2 の「loopback の接続の試みは、一覧に項目がないのですべてそれ以外」とする文面と両立するかは、K6 の確認者の判断のまま残る。DD-1 の着手の前に決める（契約の条件ではない integrator の運用。照合では済ませない）。両立しなければ K6 の新しい draftRef を起案する。
- K3/3 の引き継ぎ H2: 止めた辞書の自動取得の代わり（Main 側での取得、同梱、取得先を exact host に固定する案）は、未検証で別の draftRef が要る。別の課題として残る。
- K3/3 の引き継ぎ H1: 更新経路の定期 CI（公開 release の asset の redirect 先の host が RS-1 に含まれるかの週1回の CI と、RS-1 起因の更新の失敗が updater の error として surface されることの試験）は CP-2b の担当が決める（条件ではない。新しい workflow を要する）。
- DT-5 の引き継ぎ（#680。[dt5-decisions.md](nir1-lane-decisions/dt5-decisions.md)）: (1) 主要な local server（llama.cpp の server、Ollama、LM Studio、vLLM、SGLang）の実測（K5/3 の DT-5a）は未実施（DR-DT5-13、27）。model の重みの取得は新しい外部通信とディスクの消費になるので、委任の外として行っていない。数値の確定（DR-DT5-26）は draft の初期案のままで、実測の根拠を持たない。(2) Windows の `SO_RCVTIMEO`／`SO_SNDTIMEO` の timeout の後の socket の状態は、Winsock の文書では不定である（DR-DT5-30。未解決。安全性ではなく Windows での成功率の問題）。(3) 取消の close と join の有界性は 3 OS の手当て（DR-DT5-24）を入れたが、macOS の CI の経路が無く、macOS では実行されていない。(4) `Nir1LocalGenerationInput.config` が `pub(crate)` のままである。(5) DD-1、PUB-L、integrator への引継ぎは decisions 文書の末尾のとおり。
- HC-1 の引き継ぎ（#681。[hc1-decisions.md](nir1-lane-decisions/hc1-decisions.md)）: (1) 1 turn の予算の数値は integrator が K1b の規則5で決める（HC-1 は production code に固定値を足していない）。(2) HC-1a の実測の推奨値は DR-HC1-12 にある。(3) SQL VM steps、deadline、busy の枯渇と cancel は、run が部分的な outcome を返せず型付き error になる。この扱いは DI-1b と integrator への申し送り（DR-HC1-24）。
- DI-1c の引き継ぎ（#684。[di1c-decisions.md](nir1-lane-decisions/di1c-decisions.md)）: (1) Revision・Decision・Freshness の変更が、再観測の後から claim の COMMIT の前までに入ると、旧い request が1回送られる（残余。DR-DI1C-9 の A-18 の観測）。(2) Native 選択の可用性の上限（513 件／約 34 件）。(3) 旧い claim の API が `pub` のまま残る。
- CB-2 の引き継ぎ（#682。[cb2-decisions.md](nir1-lane-decisions/cb2-decisions.md)）: (1) workspace 不一致の message が絶対 path を含む。(2) 取消は半端な行（JSON 列だけが入り token 列が NULL の行）を消さない（DR-CB2-1 の追記）。(3) D2a の epoch の変化の `revoke_all` の順序（DR-CB2-10）。(4) Windows／macOS では locator が未実行。(5) 高リスクの判断（DR-CB2-3、-4）の advisor の結論は、decisions 文書では「未取得（integrator の作業）」のままである。
- NC-1 の引き継ぎ（#683。[nc1-decisions.md](nir1-lane-decisions/nc1-decisions.md)）: (1) K3/3 の引き継ぎ H1〜H11 の扱いは DR-NC1-40 のとおり（G-pub と H7 の所要の記録は CP-2b、H11 は記録の `verdicts.txt` で不活性の行を列挙。ほかは実装に触れない）。(2) 実行中の失敗の webContents の破棄は、同期の破棄が Electron 43.5.0 で SIGSEGV するため、handler の外の次の tick で行う（DR-NC1-18。draft の FC-1 の「その場で破棄」との差）。(3) G-open の記録は採取時の head に束縛され、`electron/main` か harness の変更で無効になる。検出は開放 commit の PR の git diff で行う（DR-NC1-46 (b)。§10.5 の 2026-10-19 追記）。(4) DR-NC1-46 (c) で未解決とした `chat-stream-workspace-switch` と、未実行だった C2-ZC の journey は、canonical Full で確認済み。
- DP-H の引き継ぎ（#677。[dp-h-decisions.md](nir1-lane-decisions/dp-h-decisions.md)）: evidence は HOLD のまま（DR-DPH-75）。(1) 置換 fixture の担当と版が未定である。(2) gate の `FIXTURE_PATH`／`FREEZE_PATH` が版 1 に固定されている。(3) freeze record の commit 数の上限が 16 である。
