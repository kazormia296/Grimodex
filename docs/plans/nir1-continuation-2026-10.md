# NIR-1 続行計画の作業記録（2026-10）

更新日: 2026-10-27（初版: 2026-10-12）

| 項目 | 値 |
|---|---|
| 状態 | NIR-1 続行計画は 2026-10-12 にユーザーが承認済み。本書は G0 で作成した作業記録 |
| 計画 | `~/.claude/plans/610-pr-c-query-nir-valiant-thunder.md`（repo 外）。承認時（21:51 JST）の本文の SHA-256 は `0bfb2a90a0b1b0e13b39b99de825674647d88621afe30855d5bed2151efb474e` で、会話記録の承認本文と一致することを G0 で照合した。23:05 JST の改訂後は `f712102e78ca4e3dc217a6e6b1fc637e6a9085050d24e7b586fb6c179ee2e335`。改訂は、Ralph から Workflow subagent への切替（§1 の U3 変更）を記録する1行の追加だけで、その行を除いた本文の SHA-256 が承認時の値と一致することで照合した。2026-10-13 00:46 JST に、B-ROUTE の行と merge 列への B-ROUTE の挿入を足した。G0 の freeze の前には、B-ROUTE の扱い（C-product の前提、§3.1）の文言を直した。その時点の SHA-256 は `408a7a48d47e0f593b1a7c1e77620b8f11b77f40a7cfee3ec37a432645d03f8c`。承認後の改訂は integrator の運用上の記録で、ユーザーが承認したのは承認時の本文（`0bfb2a90…`）である |
| 基点 | `origin/master@a153743b3f672b7274bdd748f15ef9c216dc9961`（#629） |
| 現在地（2026-10-26 JST） | master は `10f7db66`（#728。CP-2b P2。3 OS の packaged smoke〔Negative (34)〕の harness と workflow。Graph の公開 gate は閉じたまま）。2026-10-17 の Session B2 の記録（#668）の後、2026-10-25 までに次の PR が merge された（squash commit。詳細は §6）: #669 DF+、#670 X1-2、#671 DT-4、#672 決定の `created_at` を厳密に後にする修正（Full の揺れ）、#673 CB-1（schema v43）、#674 X1-3、#675 HS-1、#676 DA-1（`own-data-read` の開放 commit を除く。WebRTC の finding で止めた）、#677 DP-H（harness まで。evidence は HOLD）、#678 CQ-LIM-1〜4、#679 Session B3（K3/3）の確認の記録、#680 DT-5、#681 HC-1、#682 CB-2（＋MG-1）、#683 NC-1（K3/3 の実装）、#684 DI-1c、#685 docs の同期（#679〜#684）、#686 CB-4、#687 X1-4、#688 DI-1a、#689 DI-1b、#690 DA-1 の開放 commit（`own-data-read` を有効にする）、#691 試験の安定化、#693 docs の同期（第5陣と DA-1 の開放 commit）、#694 X1-4 の契約試験の registry と分類への登録、#695 audit の high／critical の解消、#696 CB-3（宣言の UI と宣言の状態の read 入口。gate が閉じている間は見えない）、#698 CP-3a（Related Scenes に Graph を接続する wire・IPC・合流の土台。公開は閉じたまま）、#699 audit の high の解消（Electron 43.8.3 と NC-1 の記録の採り直し）、#700 CP-3b（Related Scenes の Graph を renderer に載せる。公開は閉じたまま）、#702 DA-2a（D2a の activation の機構。起動入口は gate で閉じたまま）、#706 DA-2b（typed Native writer 9 command、D2a の失敗の表示、W-1）、#707 docs の同期（#696〜#706）、#708 `http-cache-semantics` 4.3.0（GHSA-ch52 の audit 例外を外した）、#709 DP-H S0（fixture の版の表と JS の gate）、#710 ProduceSkia の根本原因の修正（復元後の reload を WebGL の面が display から外れてから行う）、#711 K6/3 の台帳取り込みと確認規則の緩和（U8。docs だけ）、#712 DP-H S0c、#713 DP-H 版 2 の fixture と freeze、#714 DP-H S4 の前の mechanics 確認、#716 外部送信の送信前の監査 commit を停電にも耐える commit にする、#715 D′（CQ-DEFER。Related Scenes の Graph の query を begin 自身の commit の後まで保留）、#717 チャット入力の下書き保存、#718 docs の同期（#708〜#717）、#719 旧 shell の updater の zip feature の除去（cargo audit の zip の例外を解消。NIR-1 の lane ではない）、#720 DA-2b の PUB-G 前の必須 1（場面の会話でない会話の「編集して再送」を、定数に依らず状態の読取で閉じる。PR-A）、#721 CP-2b P1、#722 Graph の合流の短縮（RS-JOIN）、#723 K6/4 の確認（Session B5）の記録、#724 DA-2b の PUB-G 前の必須 3・4（PR-B）、#725 WF-WINDOW（K6/4 の批准 12）、#727 DD-1a（local 生成の Native 入口）、#726 CP-2b P3（更新経路の定期 CI）、#728 CP-2b P2（3 OS の packaged smoke）。canonical Full の最後の green は `6a8907d9`（run 40251145474。基点 `87024205`。#724〜#727 を含む。#728 は Full 未実施）で、#708 以降の Full の記録は §6 にある。次の Full の `candidate_base` は `6a8907d9`。起動時の JS graph は、#717 の測定で raw 4,250,669／gzip 1,343,227（上限は raw 4,250,700〔#717 で 700 byte 上げた〕／gzip 1,349,743）だった。2026-10-26 追記: #724 は、定数 `PROFILE_ACTIVATION_UI_ENABLED` が false の間の起動時 JS を raw 4,250,925（+0、上限 4,251,000）と記録した（上限を 4,251,000 にした PR と gzip の値は未記録）。定数が true のときは 4,252,464 で上限を超えるので、PUB-G の lane で予算の緩和が要る。Session B1（K3/2、K4/3、K5/3、K6/2、X1/1。K6/2 の条件付きの2行は事前の確認のみで、条件の成立後に改めて確認を求める）と Session B2（K2/4 の2文と proposal/7 の1文）は 2026-10-17 に、Session B3（K3/3。`caller-profile-egress`）は 2026-10-18 に、Session B4（K6/3。`nir1-final-request-packing-eval`。DD-1 の H4 の保留を解く）は 2026-10-25 に、Session B5（K6/4。`graph-eval-procedure`。Graph の follow-up の可用性。批准 6 の (i) だけが確認で、(ii) は事前の確認）は 2026-10-26 に確認済みで、それぞれ §10.3、§10.4、§10.5、§10.6、§10.7 と確認台帳に記録した。K3/3 は、DA-1 の ST1 の Y-1 の試走が見つけた renderer の外向き通信（WebRTC の接続と名前解決）を Main の network 層で塞ぐ設計で、実装（NC-1）は #683 で master に入り、G-open の記録（Linux の実機）を [`nir1-lane-decisions/nc1-g-open/`](nir1-lane-decisions/nc1-g-open/README.md) に置いた。`own-data-read` の開放 commit（DA-1 の ST3）は、ユーザーが 2026-10-19 に「DA-1 の own-data-read を有効にする」と指示し、#690 で merge 済みである（G-open の記録は開放 commit の head `d91c24f1` で採り直した。DR-DA1-35、36）。残る lane は CP-2b（P1 は #721、P3 は #726、P2 は #728 で master。P4〔G-pub の記録〕は実行中。§4）、CP-4（D′ は master に入った。実 Electron での確認 (ii) と H5 は統合 branch で取られた。K6/4 の確認で、条件が成立しない間の可用性は表示の可用性の欠落率で判定する。RS-JOIN の hook〔#722〕と W_f の製品の変更〔#725〕が master にそろったので HOLD の条件は満たされた。実際の評価〔S5〕は、ユーザーに評価専用 build の件を伝えてから行う。§4）、DD-1（K6/3 の確認で保留は解けた。DD-1a は #727 で master。次は DD-1b）、DA-2b の PUB-G 前の必須（件 1 は #720、件 3・4 は #724 で master に入り、必須の 3 件は master にそろった。件 5 は PUB-G を止める項目で Session C-1 で確かめる。§11）、PUB-G／PUB-L（Session C の承認後）。DP-H の evidence は 2026-10-25 に版 2 で PASS した（DP-H 単体。DP-1 の証跡でも P-12 の証跡でもない。§4、DR-DPH-120）。閉じたままの gate は `PRODUCT_GRAPH_PUBLISHED=false`、`NIR1_GRAPH_UI_ENABLED = false as const`、`BODY_DECLARATION_UI_ENABLED=false`、`PrePublicationEntry::ProfileActivation`（既定で閉）、`PROFILE_ACTIVATION_UI_ENABLED = false as const`。Graph の公開（PUB-G）、activation の UI と開示文言（Session C-1）、DA-2 の activation の入口、local 送信の公開（PUB-L）は未承認で閉じたまま。PUB-G／PUB-L は Session C で確認する。2026-10-25 に運用を改めた（§12） |
| 位置づけ | ユーザー決定、委任判断、レーン、merge 列、worktree 台帳の記録。契約の批准、閾値の変更、製品公開の根拠にはしない |
| 正本 | 契約と確認台帳は [L6〜L9実行計画](nir1-l6-l9-execution-plan.md)、残工程の依存と受入れは [post-B実行計画](nir1-post-b-execution-plan.md)、委任の規則は [GDX-PRECHECK-001](../../policies/quality/iron-laws.md#GDX-PRECHECK-001) |

## 1. ユーザー決定（逐語）

決定日は 2026-10-12（JST）。ただし U7 は 2026-10-13（JST）、U8 は 2026-10-25（JST。integrator の伝える逐語を、Session B4 の記録の時に転記した。時刻は会話記録の timestamp）。integrator セッション（`3754f9a7-620d-4e21-ad37-3096691a96be`）の会話記録にあるユーザー自身の回答を、G0 で照合して逐語で転記した。U7 は同じセッションの会話記録にあるユーザー自身のメッセージを、merge 規則の変更時（2026-10-13）に逐語で転記した。選択肢を選んだ回答は、その選択肢の label を逐語とする。問いは要旨である。

SB-1〜SB-5 は、Session B の前にユーザーが出した決定と選択である（SB-1 は 2026-10-13、SB-2〜SB-5 は 2026-10-14、JST）。同じセッションの会話記録にあるユーザー自身のメッセージと構造化質問への回答を、2026-10-14 に照合して逐語で転記した（時刻は会話記録の timestamp）。SB-6 と SB-7 は 2026-10-18（JST）の決定で、Session B3 の記録の時に、同じ integrator セッション（`fa34d6ef-ff00-4f4d-846d-7ccee58abf30`）の会話記録にあるユーザー自身のメッセージと構造化質問への回答を照合して逐語で転記した（時刻は会話記録の timestamp）。SB-8 は 2026-10-25（JST）の選択で、Session B4（K6/3）の記録の時に integrator の伝える逐語を転記した（時刻は会話記録の timestamp）。U9、SB-9、SB-10、U10、SB-11 は 2026-10-25（JST）のユーザーのメッセージで、docs の同期（`claude/docs-sync-20261025b`）の時に、integrator の伝える逐語を転記した。この同期では会話記録との照合も timestamp の確認もしていないので、時刻の列は日付だけにし、問い（要旨）は integrator の伝える範囲で書き、記録者の解釈は「記録者の解釈」と明記した。SB-12 と SB-13 は 2026-10-25（JST）のユーザーのメッセージで、Session B5（K6/4）の記録（`claude/k6-4-ledger`。2026-10-26）の時に、integrator の伝える逐語を転記した。扱いは U9〜SB-11 と同じ（会話記録との照合と timestamp の確認はしていない）。SB-14 と SB-15 は 2026-10-26（JST）のユーザーのメッセージで、同じ記録の時に integrator の伝える逐語を転記した（扱いは同じ）。K6/4 の確認そのもの（構造化質問への回答）は §10.7 に記録し、この表には置かない。どれも契約の確認文ではない。契約は、書き直した draft に対して、ユーザーが明示に承認したときだけ確認される（2026-10-25 までは逐語の確認文を打ったときだけ。U8 で、1つの draftRef と1つの contractId を曖昧さなく特定する承認に緩和した）。契約の draft によっては、同じ決定を別の名前（K3 の /2 と K2 の /3 の UB1・UB2、K5 の /3 の UB-K5、K3 の /3 の UB3〔SB-6〕）で引く。

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
| U8 | 10-25 | 問いへの回答ではない。K6/3 の確認文（§10.6）を受け取った直後に、ユーザーが出した確認の規則の変更の指示 | 「この固定文言の確認めんどいので、台帳の規則を完全一致じゃなくてもOKにしてください」 | 確認台帳の Confirmation protocol を改め、固定の文との一致を要求しない。行は、1つの `draftRef` と1つの `contractId` を曖昧さなく特定する明示の承認で確認される（発言が両方を名指すか、直前の integrator のメッセージがちょうど1つの `draftRef#contractId` を draft の SHA-256 つきで示した問いに承認で答える。構造化質問への回答でもよい）。integrator は返答を逐語で、受信の日時、示した ref と SHA-256、取り込んだ draft の byte 同一性とともに記録する。計画への同意、merge の指示、1つの行を示した問いへの返答でない包括的な言い方などは確認にならない。2026-10-25 より前の exact statement による確認は履歴として有効。AGENTS.md と GDX-PRECHECK-001 は変えない（完全一致を書いていない） |
| SB-1 | 10-13 19:40 | 問いへの回答ではない。K3 と K5 の書き直しの提案（renderer が乗っ取られうる前提は保ち、守る場所を「平文を外へ出す経路」に絞る。外へ出ない機能は制限モードでも開く〔K3 の O-2〕。local 送信の同意は送信先ごとに1回〔K5 の B〕）への返答 | 「それで行きましょう。K5はCで。ローカルLLMを使う人は基本的にリテラシーが高いと思うので釈迦に説法でしょう。」 | K3 は O-2、K5 は C（Main の同意ダイアログを置かず、利用者の AI 使用ポリシーと接続先の設定を同意とみなす）で書き直す。乗っ取られた renderer が設定を変えて送信を始めうることなどは残余として開示する。確認は、書き直した版（K3 の /2、K5 の /3 など）に対して逐語の確認文で行う |
| SB-2 | 10-14 04:06 | 問いへの回答ではない。K3 の /2 のレビューが、Web Editor の handoff の取込みを根拠に防御の追加を求めていたときの、ユーザーの指示 | 「web editorは廃止し、再公開の予定もないのでhandoffの考慮は不要です」 | Web Editor の handoff の取込みと、Web Editor を前提にした脅威・同意の議論は、K2〜K6 の契約と設計の考慮の対象外とする。製品からの取込み経路の削除は、別に依頼されたときだけ行う |
| SB-3 | 10-14 10:02 | 場面の本文を保存するたびに承認済みの型付き Revision がすべて失効し、執筆中は Graph が実質使えない（X1）。確認済みの契約は「本文・題名・順序の更新で旧 Revision を失効させる」と書くが、どの Revision かは書かず、L9 と post-B は本文の保存の後も履歴が続くことを求める。どう扱うか（選択肢は「本文では失効させない (推奨)」「依存するものだけ失効」「今のまま」） | 「依存するものだけ失効」 | 編集した場面の Scope の解決に依存する Revision だけを失効させる（L5 の `nir1-scope-dependency-delta/1` と同じ投影型の考え方）。新しい draftRef（`nir1-scene-scope-projection-proposal/1`）を起案して確認を求める。確認文が要らない委任の範囲の修正（X1-1。DR-X1-1）は先に進める |
| SB-4 | 10-14 10:02 | 50場面・場面ごとに review した現実の形では、主人公は約40件の Revision に入り、値を変えない最適化の後でも records 約900（上限512）、steps 約21万（上限10万）が要る。時間は最大 37.7 ms で 100 ms に収まる。資源の上限をどう進めるか（選択肢は「実測から決め直す (推奨)」「review の粒度を見直す」「今の値のまま」） | 「実測から決め直す (推奨)」 | 委任の範囲の最適化と数え方の修正（CQ-OPT、B-GUARD、CQ-AVAIL、CQ-MEM）の後に、現実の形の fixture で測り直す。その実測から records と steps の値、worker のメモリ（RB-2）と Revision の大きさの数え方（RB-1）を見直す資源契約の新しい版（proposal/7）を起案して確認を求める。100 ms の時間の上限は防御として残す |
| SB-5 | 10-14 10:02 | 主人公級の人物を seed にすると、2 hop で Entity が 12 を超えることが多い。確認済みの契約は「超えたら Graph 全体を出さない」。超えたときの挙動をどうするか（選択肢は「上限を上げる (推奨)」「決定的に打ち切る」「今のまま」） | 「上限を上げる (推奨)」 | 値は proposal/7 で実測から決める。それでも超えたときは、今どおり Graph 全体を出さない（部分的な Graph は出さない） |
| SB-6 | 10-18 02:07 | 問いへの回答。DA-1 の ST1 の Y-1 の試走が、renderer から外への接続経路（`RTCPeerConnection` の `iceServers` に `turn:`／`turns:` を渡すと Chromium が外へ接続する WebRTC の経路）を見つけ、`own-data-read` の開放 commit を `[precheck]` で止めた。integrator が文章で3つの選択肢（1: 構造的に塞ぐ設計を起案する〔推奨〕、2: 残余として開示して受け入れる、3: O-2 をやめる）を示し、どれにするかを問うた。AskUserQuestion の選択ではなく、通常のメッセージで答えた | 「１で行きましょう」 | 案1 を選ぶ。構造的に塞ぐ設計を K3/3（`nir1-d2a-activation-proposal/3`）として起案し、確認を求める。確認文ではない。確認までは、開放 commit、DA-2、activation の公開、PUB-G を止める。K3/3 の draft は、この決定を UB3 と呼んで引く（原文の出所は、K3/3 の引き継ぎ H6 に従い、ここに記録した） |
| SB-7 | 10-18 12:02 | proposal/7 の実装（CQ-LIM）の X1-3 の後の再測で「registration の使用量が Q の 85% を超える」に当たり、`[precheck]` で止まった。CQ-LIM をどう進めるか（AskUserQuestion。質問は 10:34 に提示。選択肢は「まず実装で直す（推奨）」「proposal/8 を起案する」「CQ-LIM を保留する」） | 「まず実装で直す（推奨）」 | 値は変えず、registration の処理を軽くして再測する。85% 以下に戻れば proposal/7 のまま進め、戻らなければ proposal/8 を起案する。実装で解消した（DR-CQL-13。#678）ので、proposal/8 は要らなかった。確認文ではない |
| SB-8 | 10-25 | 問いへの回答。DD-1 は、K3/3 の引き継ぎ H4（K6/2 の DD-1 の分類が、NC-1 の下で毎回起きる LS-1 への接続と blackhole された辞書の要求と両立するかは K6 の確認者の判断）により着手を保留していた。integrator はその保留の理由と、案 A（K6 の新しい版 /3 を起案する）・案 B（K6/2 の現文面のまま進める）を示し、A を推奨した（問いは integrator の要約による。時刻は会話記録の timestamp） | 「Aで」 | 案 A を選ぶ。K6/3（`nir1-final-request-eval-proposal/3`）を起案して確認を求める。起案の指示で、確認文ではない（K6/3 の draft も、この選択を確認として扱わないと書く）。K6/3 は 2026-10-25 に確認された（§10.6） |
| U9 | 10-25 | 問いへの回答かは、この同期では確かめていない。CP-4 の診断（Graph が製品の通常の経路でほぼ使えない原因は、begin 自身の監査の commit が worker の registration／query の `ReadIdentity` の drift と衝突すること。DR-CP4-S1C2-19〜22）を受けた、監査の扱いについての発言 | 「Opusに判断させて欲しいんですが、監査の記録は後回しqueに突っ込んで、Graph構築優先で良いんじゃないでしょうか？落ちたら落ちたで良いですが、外部送信時のログだけは、異常終了時でも記録されるか、次回起動時に記録する保証は欲しいかもしれません。」 | 確認文でも、監査の変更の承認でもない。integrator は Opus の 3 視点で判断させた。結論: メモリ上の queue は GDX-AI-AUDIT-001（local-model の dispatch の前に durably append）に反する重要な変更。spool（別 SQLite）は新しい永続 file・hash chain への編入の遅れ・本文の写しの置き場所を伴う重要な変更。効果は薄い（合流の経路が約 15 ms〈推定〉で窓 10.84 ms を超える）。外部送信の監査は既に送信前に主 DB へ同期 commit で、停電では最後の group commit を失いうる点だけが弱い。この結論は integrator と Opus の判断で、ユーザーの決定ではない |
| SB-9 | 10-25 | 問いへの回答。integrator が U9 の結論を受けて示した推奨（D′ → 実 Electron の実測 → 合流の短縮 → 必要なら spool／C 案を再提案。監査には触れない）と、2 点目（外部送信の停電対策。本文以外の保存の扱いを含む）への返答。問いの正確な文面は、この同期では確かめていない | 「1.とりあえずそれで行きましょう2.本文以外は流石に良いんじゃないか？いやでもチャットで入力途中とかってどうなってるんですかね？モダンなアプリだと入力途中で落ちても、再起動したらそのままだったりしますよね。」 | 記録者の解釈: 1 は推奨に合意（監査の契約には触れない）。2 の意図は確認しきれず、直後の質問（チャット入力の保存）に進んだ。確認文ではない |
| SB-10 | 10-25 | 問いへの回答。SB-9 の 2 を受けた integrator の確認への返答 | 「2やって欲しい。チャットの入力途中もやって欲しい。」 | 外部送信の停電対策（a+）と、チャット入力の下書き保存を依頼。#716（外部送信の送信前の監査 commit を停電にも耐える commit にする）と #717（チャット入力の下書き保存）で実施した。確認文ではない |
| U10 | 10-25 | 問いへの回答ではない。監査の C 案（別 DB、spool など）についての質問 2 件 | 「ちなみに監査のC案って何かトレードオフあるんですか？」「ちょい実装範囲広いけど悪くはない感じですかね？」 | 質問であり、決定ではない。C 案は今は進めない（(a)（窓内率）を通す手段の 1 つとして §4 の CP-4 の行に残る。重要な変更なので、進めるときはユーザーの確認が要る） |
| SB-11 | 10-25 | 問いへの回答。チャット入力の下書き保存について、integrator が示した 2 点（(1) 保存先を renderer の localStorage とし、プライバシー通知を追記する案、(2) session を切り替えると今の下書きを元の session に保存して入れ替える挙動〔Slack 型〕）への返答 | 「OK,1,2両方とも承認します」 | (1) と (2) を承認。通知の版 v2.0 は上げない方針で実施した（#717）。初期 JS の raw の上限を最小限だけ上げることは、このメッセージではなく 2026-10-25 の既存の指示（lazy 化が先、足りない分だけ最小限を独立 commit で緩和し開示。§12.1）に従った。確認文ではなく、契約の批准でも公開の承認でもない |
| SB-12 | 10-25 | 問いへの回答。K6/2 の (a)（定常状態の窓外率）が D′（#715）の下で構造上 HOLD になる（Graph は常に最初の表示に遅れ、`graph-ready` の後の取り直し〔cache 由来〕でだけ renderer に届く）ことを受けて、integrator が示した選択肢への返答。A は「再 query の cache 由来の結果も、一定時間内なら可用性に数える定義を持つ新しい K6 の draft を起案する」（integrator の伝える要旨。問いの逐語とほかの選択肢は、この記録では確かめていない） | 「K6/2はAで」 | 記録者の解釈: 案 A を選ぶ。K6/4（`nir1-final-request-eval-proposal/4`。contractId は K6/2 の条件付きの行と同じ `graph-eval-procedure`）を起案して確認を求める。起案の指示で、確認文ではない（K6/4 の draft も、この指示を確認として扱わないと書く）。W_f、T_late と T_show の値、数える条件、品質の扱い、確認の効力の 2 段、(b) の読み替え、製品の変更の要件、候補の限定は、起案者が integrator の指示を受けて加えたもので、この指示の選択を経ていない（K6/4 の draft の注記）。K6/4 は 2026-10-26 に確認された（§10.7） |
| SB-13 | 10-25 | 問いへの回答かは、この記録では確かめていない。cargo audit の zip 4.6.1（RUSTSEC-2026-0367〜0369）の例外（2026-11-18 に失効）について、ユーザーの判断が要るとされていた点（frozen legacy の旧 Tauri shell の `tauri-plugin-updater` の zip feature を外すか、例外を延長するか。§11 の期限）に関する発言 | 「旧シェルのzip featureは外しましょう」 | 記録者の解釈: zip feature を外す方を選ぶ（延長しない）。#719（`ac9b4178`）で実施した: `src-tauri/Cargo.toml` の `tauri-plugin-updater` を `default-features = false`、`features = ["rustls-tls"]` にし、zip とその固有の依存を `src-tauri/Cargo.lock` から外し、`.cargo/audit.toml` の zip の例外と期限を外した。旧 shell は CI でも release でも build されない。確認文ではなく、契約の批准でもない |
| SB-14 | 10-26 | 問いへの回答ではない。CP-2b P1（#721）の報告の中の「worker の同梱による約 90 MB のディスク増」についての質問 | 「worker の同梱による約 90 MB のディスク増ってのは何ですか？」 | 質問であり、決定ではない。integrator の説明（記録者の要約）: worker は Graph の問合せを別 process で動かすプログラム `nir1-c-query-worker` で、約 91.5 MB のうち約 84 MB は、メモリの上限を守るための固定 heap が実行 file に入っているため。installer と更新 zip は gzip で約 3.2 MB しか増えないが、install 後のディスクは約 90 MB 増える |
| SB-15 | 10-26 | 問いへの回答。SB-14 の説明を受けて、worker の同梱をどうするかについての返答 | 「そのままで進めて」 | 記録者の解釈: worker の同梱をそのまま出す（CP-2b を今の形で進める）。heap を実行時の確保に直して縮める案は後続の課題（§11）で、C-resource の受入れの対象なので、変えるときは審査が要る。release の前にあらためて相談する扱いは取り下げた。確認文ではなく、契約の批准でも公開の承認でもない |

計画は 2026-10-12 21:51（JST）に承認された。U3 の「1」が指す選択肢の提示文は「#610 型の委任（worker/owner/終了処理/lifecycle の技術判断を作業記録に残して進める）を NIR-1 残レーンへ広げ、表記を 100 ms／aggregate cap なしへ更新する。新しい送信先・保存範囲・閾値緩和・製品公開・新しい契約は従来どおり確認する。AGENTS/iron-laws を更新する PR が必要。」である。表記の扱いは、承認済みの計画に従い、確認台帳の現行閾値と Gold への参照に置き換える。判断の記録先は §3.2 の形式に従う。提示文はユーザーの発言ではなく、選ばれた選択肢の範囲を示す記録として残す。

U3 変更で選ばれた選択肢の提示文は「Ralph の代わりに、このセッションの Workflow subagent（通常の権限、auto mode の安全判定あり）で実装する。進め方は builder→reviewer→fix で同じ。push、commit、gh を禁じる guard hook が無くなるが、subagent はこのセッションの権限判定の下で動くので、安全性はむしろ高い。」である。もう一方の選択肢（ユーザーが permission rule を追加して Ralph を再開する）は選ばれていない。計画ファイルには同じ 23:05 に、この変更を記録する1行（実行方式の「2026-10-12 の変更」）が追加された。この提示文もユーザーの発言ではなく、選ばれた選択肢の範囲を示す記録として残す。

## 2. 計画の要約

- NIR-1 の残工程を並列のレーンに分け、merge まで進める（U4）。製品入口（Graph、送信）は PUB-G／PUB-L まで閉じたままにする（A-1）。
- 9/25-26 の承認と WIP は使わず（U1）、契約は K1〜K6 として最新 master 前提で起案し直す。
- 2 MiB／8 ms は前提にしない（U2）。資源契約は防御用の上限に簡素化し、K1 で確認する（U6）。K1 は 2026-10-12 に確認された（§10.1）。
- 確認セッションは A（K1）、B（K2〜K6）、C（PUB-G、PUB-L）の3回とする。Session B は、K3〜K6 と X1 を示す B1（2026-10-17 に確認済み。§10.3）と、K2/4 と proposal/7 を示す B2（2026-10-17 に確認済み。§10.4）と、K3/3 を示す B3（2026-10-18 に確認済み。§10.5）と、K6/3 を示す B4（2026-10-25 に確認済み。§10.6）と、K6/4 を示す B5（2026-10-26 に確認済み。§10.7）と、SP/1 を示す B6（2026-10-27 に確認済み。§10.8）に分けた。確認されなかった行のレーンだけを `[precheck]` で止め、ほかのレーンは止めない。
- CI 保守は扱わない（U5）。保守の失敗で PR の Security job が止まった場合は、merge 列を止めて実装を続け、ユーザーに報告する。master の Full が赤になった場合は、§6 の優先対応に従う（U7）。

### 2.1. 契約（起案予定。9/25 の文面は流用しない）

| K | draftRef と contractId | 止めるもの | 状態 |
|---|---|---|---|
| K1 | `nir1-l6-l9-contract-proposal/6`：`graph-limited-binding`、`nir1-defensive-resource-limits` | CR-REC の HOLD 解除、Graph の根拠、HC-1、DT-5、CB-4、CP-1 の数値 | 確認済み（2026-10-12、Session A。2行とも。§10.1） |
| K2 | `nir1-c-body-disclosure-proposal/4`：`graph-target-scene-body-disclosure`、`scope-storage-authority` の差分（/2 と /3 は確認を求めず superseded） | CB-1〜4、CP-3 の Graph-only 追加、G-01、PUB-G | 2026-10-17 の Session B2 で2文とも確認された（§10.4） |
| K3 | `nir1-d2a-activation-proposal/2`：`caller-profile-egress` の差分（/1 は確認を求めず superseded） | DA-1／2、CP-3a、PUB-G、DD-1 | 2026-10-17 の Session B1 で確認された（§10.3） |
| K3/3 | `nir1-d2a-activation-proposal/3`：`caller-profile-egress`（K3/2 と同じ contractId の新しい draftRef。renderer の外向き通信〔WebRTC の接続と名前解決〕を Main の network 層で塞ぐ設計。SB-6） | NC-1、DA-1 の ST3 の開放 commit、CP-2b、PUB-G、DD-1 | 2026-10-18 の Session B3 で確認された（§10.5）。実装（NC-1）は #683 で master。DA-1 の ST3 の開放 commit は #690 で merge 済み |
| K4 | `nir1-d2b-history-mapping-proposal/3`：`history-reauthorization` の差分（/1 と /2 は確認を求めず superseded） | DF+-a、HS-1、HC-1、DI-1b／c | 2026-10-17 の Session B1 で確認された（§10.3） |
| K5 | `nir1-d2b-local-send-proposal/3`：`nir1-local-product-send` と、`caller-profile-egress` の差分（B-1〜B-4）の2文 | DF+-b、DT-4／5、DD-1、PUB-L | 2026-10-17 の Session B1 で2文とも確認された（§10.3） |
| K6 | `nir1-final-request-eval-proposal/2`：`nir1-final-request-packing-eval`（条件付きで `g01-eval-revision`、`graph-eval-procedure`）（/1 は確認を求めず superseded） | DP-H、DD-1、PUB-L、条件付きで CP-4 | `nir1-final-request-packing-eval` は 2026-10-17 の Session B1 で確認された。条件付きの2行は事前の確認のみで、条件は未成立のため効かず、条件の成立後に receipt を添えて改めて確認を求める（§10.3）。2026-10-26 追記: `graph-eval-procedure` は K6/4 の /4 の行が確認され（批准 6 の (i)）、条件の成立の後に改めて確認を求めるのは /4 の行になった。/2 の行は事前の確認の履歴として残る（§10.7） |
| K6/3 | `nir1-final-request-eval-proposal/3`：`nir1-final-request-packing-eval`（K6/2 と同じ contractId の新しい draftRef。DD-1 の接続の試みの分類と NC-1 の両立、版の番号の読み替え。SB-8） | DD-1、DP-H の置換版、PUB-L | 2026-10-25 の Session B4 で確認された（§10.6）。K6/2 の行を全体として supersede する。条件付きの2行は対象外で変わらない |
| K6/4 | `nir1-final-request-eval-proposal/4`：`graph-eval-procedure`（K6/2 の条件付きの行と同じ contractId の新しい draftRef。Graph の follow-up の可用性〔`graph-ready` による再 query の cache 由来の表示〕を定義し、可用性を表示の可用性の欠落率で判定する。合格基準の緩和 5 点。SB-12） | CP-4、W_f の製品の変更（新しい lane）、PUB-G の開示 | 2026-10-26 の Session B5 で確認された（§10.7）。批准 6 の (i) だけが確認（`confirmedRef`）で、(ii)（K6/2 の 614 行の Delta、620 行の Lane unlocked、621 行の受入れへの影響）は事前の確認にとどまり、条件の成立と改めての確認の後にだけ効く。緩和は D′、RS-JOIN の hook（PR #722）、W_f の製品の変更をすべて含む候補に限り、それまで CP-4 の可用性は HOLD。K6/2 の /2 の行は履歴として残る。`g01-eval-revision` は変わらない |
| SP/1 | `nir1-graph-case-seed-pin-proposal/1`：`graph-case-seed-pin-setup`（新規の contractId。凍結した G-case の問いの場面に、予定の seed の Entity への pin を 1 つ足す setup の addendum。K6/4 の R5 の照合を満たす手段。G-01 を含み、候補 §7 の「唯一の pin」を問いの場面の seed の pin についてだけ読み替える） | CP-4、CP-0 の側の setup、PUB-G の評価の証跡 | 2026-10-27 の Session B6 で確認された（§10.8）。効力は承認の直後から。ただし足した pin を使う評価の run は、R5 の照合と観測前の commit（独立 reviewer のレビューつき）の後に限る。K6/4、K6/2、K2/4 の行は変わらない。Graph の公開（PUB-G）と Session C-1 の承認ではない |
| P7 | `nir1-l6-l9-contract-proposal/7`：`graph-limited-binding`（proposal/6 の資源の値の改訂。SB-4、SB-5。`nir1-defensive-resource-limits` は規則を変えず、確認文はない） | CQ-LIM-1〜4、C の受入れ（G-1、G-2）、PUB-G | 2026-10-17 の Session B2 で確認された（§10.4）。実装（CQ-LIM-1〜4）は X1-3 の merge の後の再測を終えて、#678 で master |
| X1 | `nir1-scene-scope-projection-proposal/1`：`scope-storage-authority` と `typed-revision-material` の差分（本文の保存で承認済みの Revision を失効させない。SB-3） | X1-2／3／4、K4 の前提 XP、CP-4 | 2026-10-17 の Session B1 で2文とも確認された（§10.3） |

確認は、確認台帳の protocol（[L6〜L9実行計画](nir1-l6-l9-execution-plan.md) の Confirmation protocol）に従い、1つの draftRef と1つの contractId を曖昧さなく特定する明示の承認で行う（2026-10-25 に U8 で緩和した。固定の文との一致は要らず、自由な文でも、integrator が1つの `draftRef#contractId` を draft の SHA-256 つきで示した問いへの承認の返答でもよい。2026-10-25 より前は、exact draftRef を名指した1文で行い、その記録は履歴として有効）。draft は契約ごとに別ファイルにし、merge しない branch で SHA を固定する。確認された draft は byte 同一で台帳へ取り込む。

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
| CB-1〜4（MG-1 を含む） | C-body v1 | CB-1／3／4 は Workflow subagent、CB-2 の writer と MG-1 は integrator | K2（2026-10-17 の Session B2 で確認済み）、DT-3、CP-1（どちらも master）の後。CB-1 は着手でき、merge は LEDGER-1 の後。CB-2 は CB-1 の後、CB-3 は CB-2 と並行、CB-4 は CB-1 と CP-1 の後に作り CB-2 の後に merge する（詳細は §10.4）。現状: CB-1 は #673、CB-2（＋MG-1）は #682、CB-4 は #686、CB-3 は #696 で master（4 本とも merge 済み。宣言の UI は `BODY_DECLARATION_UI_ENABLED=false` で閉じたまま） |
| DA-1／2 | D2a の route 区分と activation | integrator | K3（2026-10-17 に確認済み。K3/3 を 2026-10-18 に確認）の後。DA-1: ST1・ST2・ST4 と ST3 の開放の前は #676 で master。ST3 の開放 commit（`own-data-read` を有効にする commit）は、NC-1 の merge と G-open の記録の後に入れる。条件は満たし、ユーザーの 2026-10-19 の指示で #690 として merge 済み（G-open の記録は開放 commit の head `d91c24f1` で採り直した。canonical Full は run 39267874715 で green。§10.5）。DA-1 は merge 済み。DA-2 は DA-1 の merge、MG-1（CB-2）の merge、CP-3a の merge の後（MG-1 は #682 で master）。現状: DA-2 は DA-2a（機構。#702）と DA-2b（typed Native writer と D2a の失敗の表示、W-1。#706）が master。activation の起動入口と UI は `PrePublicationEntry::ProfileActivation`（既定で閉）と `PROFILE_ACTIVATION_UI_ENABLED = false as const` で閉じたまま。開けるのは PUB-G と Session C-1 の承認の後。2026-10-25 時点で、DA-2b の PUB-G 前の必須 3 件（`da2b-renderer-decisions.md` の冒頭の表の 1、3、4。§11）は未着手。2026-10-26 追記: 件 1 は PR-A として #720 で merge 済み（`c87bd446`。場面の会話でない会話の「編集して再送」を、定数に依らず状態の読取で閉じる。DR-DA2B-R17、R18）。PR-B（件 3・4）は実装中だった（次の追記のとおり #724 で merge 済み）。PR-A の独立レビュー（P1-1）で、PUB-G を止める項目が冒頭の表の行 5 に加わった: 場面の会話でも、route が capture の外なら restricted で「編集して再送」が行を消す（閉じていない。Session C-1 でユーザーに確かめる。§11）。2026-10-26 追記: 件 3・4 は PR-B として #724（`8e93bb31`）で merge 済み。AI の入口の閉鎖を定数 `PROFILE_ACTIVATION_UI_ENABLED` の後ろで広げ、送信の閉鎖を 3 状態にした。定数 false の間の起動時 JS は raw 4,250,925（+0、上限 4,251,000）。定数 true のときは 4,252,464 で上限を超えるので、PUB-G の lane で予算の緩和が要る。文言は案で、承認は Session C-1 の束。これで DA-2b の PUB-G 前の必須 3 件（件 1＝#720、件 3・4＝#724）は master に入った |
| NC-1（2026-10-18 追加。K3/3 の実装。名前はこの記録の仮の名前） | Main の network 閉じ込め（NC-1）、LS-1 の listener、FC-1、MD-1、`host-resolver-rules`（K3/3 の設計）。工数は約7日（推定。G-open の再走の幅を含む。harness の CI 化、更新経路の定期 CI、CP-2b の追加分は含まない） | Workflow subagent。高リスクの PR（起動の順序、network、listener）なので lifecycle とセキュリティの reviewer を2名にする（§5） | 開始条件: K3/3 の確認（2026-10-18）。DA-1 の ST1（#676）は master。merge は DA-1 の開放 commit（ST3）の前。ゲート G-open（Linux の実機。DA-1 の ST3 の開放 commit の条件）と G-pub（3 OS の packaged smoke。PUB-G の条件。CP-2b に Y-1 を各 OS で行うことを加える）。条件は K3/3 の draft のゲート表が正本（詳細は §10.5）。現状: #683（`a8ee82d5`）で master。G-open の記録は Linux の実機（`nir1-lane-decisions/nc1-g-open/`）。G-pub は CP-2b の範囲で未実施 |
| DF+-a／b | D-final 追補 | Workflow subagent | K4（a）、K5（b）の後。#669 で master |
| DT-4 | audit、route、consent | integrator | K5 の後。#671 で master |
| DT-5a／b | transport | Workflow subagent | K5、DF+-b、DT-1〜3 の後。DT-5 は #680 で master。DT-5a の主要な local server の実測は未実施（§11） |
| HS-1、HC-1a／b | history の保存と再認可 | Workflow subagent | K4、DF+-a、HP-1 の後。HS-1 は #675、HC-1 は #681 で master。HC-1a の実測は推奨値まで（数値は integrator が K1b の規則5で決める。§11） |
| DP-H | 最終 request 評価 harness | Workflow subagent | K6 の後。harness は #677 で master（2026-10-18）。#677 の時点の evidence は HOLD: 観測により失効した版 1 の fixture を、別の作者が X1-3 の後のコードから導き直す置換 fixture と、独立 review の後に実行する、という扱いだった。DR-DPH-86 の「K6/3 の確認まで置換 fixture を置かない」は、2026-10-25 の K6/3 の確認で解けた（DR-DPH-89。§10.6）。現状（2026-10-25）: 版の表と gate は #709（S0）、契約と harness への unknown Scope の拒否 variant の追加と gate の版 2 への対応は #712（S0c）、版 2 の fixture・独立期待値 review・freeze（S1〜S3）は #713、S4 の前の mechanics 確認は #714 で master。その後、S4（版 2 の evidence の実行）は PASS した（master `6592b71b`、runner exit 0、request 29 件〔正例 17・拒否 12〕すべて pass、failed 0・invalid 0）。scope は DP-H のみで、DP-1 の証跡でも P-12 の証跡でもない（`dp1Evidence: false`、`p12: not-measured`）。実施者は作者・reviewer とは別の Opus。観測の中身（variant ごとの判定）は repo に書かない（DR-DPH-67 の規則）。記録は DR-DPH-120 |
| CP-3a／b | wire、IPC、seed の UX | Workflow subagent | CP-2a（master）、CB-4、DA-1 の merge の後（CB-4 は K2/4 の確認で着手できる）。CP-2a、DA-1（#676、開放 commit は #690）、CB-4（#686）は master で、CP-3a の前提は満たした。現状: CP-3a は #698、CP-3b は #700 で master（どちらも公開は閉じたまま。`NIR1_GRAPH_UI_ENABLED = false as const`、`PRODUCT_GRAPH_PUBLISHED=false`） |
| DI-1c／a／b | D1 最終統合（3分割） | Workflow subagent | c は DF+、DT-1〜3、HS-1 の後。a は CP-1／2a の後。b は HC-1 の後。現状: c は #684、a は #688、b は #689 で master（3 slice とも merge 済み。DI-1 全体の合格は 3 slice の受入れ別に判断し、DI-1b の merge だけで合格にしない） |
| X1-1〜4（X1/1） | 本文の保存で承認済みの Revision を失効させない（SB-3） | integrator が割り当てる | X1/1 の確認（2026-10-17）。X1-1 は #662、X1-2 は #670、X1-3 は #674、X1-4 は #687 で master（4 本とも merge 済み）。列には置かない（§6） |
| CQ-LIM-1〜4（2026-10-17 追加。名前は proposal/7 の draft の仮の名前。2026-10-18 に #678 で master） | proposal/7 の実装（C-resource の追補）。CQ-LIM-1：`MAX_GRAPH_RECORDS` を Revision 用と query 用に分け、records・pages・steps・Entity・edge を変える（約2日）。CQ-LIM-2：Q 16 MiB、Native 領域 3 MiB、registration の検査（約3.5日）。CQ-LIM-3：RB-1 の writer の検査と台帳・試験の期待値の同期（約1日）。CQ-LIM-4：G-03 の作り直しと再 freeze（約1.5日）。合計は約8日（推定） | 未指定（integrator が割り当てる） | proposal/7 の確認（2026-10-17）。着手は X1-3 と並行してよい。merge は X1-3 の merge の後の再測を終えてから。CQ-LIM-4 は CP-4 の G-03 の観測の前と、CP-4 の観測前の commit の前に終える。現状: #678（`a789039a`）で master。X1-3 の後の再測で registration の使用量が Q の 85% を超えて `[precheck]` で止まったが、ユーザーが「まず実装で直す（推奨）」を選び（§1 の SB-7）、実装で解消した（DR-CQL-13）ので proposal/8 は不要だった。G-03 の re-freeze は独立 reviewer の approve を得て、`evals/nir1-graph/freeze.v1.json` の sha256 は `6080530adc0a7d2d45896005664f6f498d5f28c3eeed517875f8f599faa8bae7`（K2/4 の addendum はこの sha を引く） |
| CP-2b | worker の同梱と 3-OS packaged smoke | 未指定 | audit 例外が解消されていれば単独。解消されていなければ PUB-G に同梱し、Session C-1 でリスク判断を求める。K3/3（2026-10-18）で範囲が広がる: 3 OS の packaged smoke に Negative (34) を加え（G-pub）、Y-1 を各 OS で行う。観測の道具（packaged への CDP の注入、net log の取得、canary の受信 socket）の方式は CP-2b の着手時に決める。更新経路の定期 CI（K3/3 の引き継ぎ H1）の担当も CP-2b の担当が決める（条件ではない）。現状（2026-10-25）: 未着手。2026-10-26 追記: audit の例外は、pnpm の GHSA-ch52 が #708、cargo の zip が #719 で解消し、どちらも無い（§11 の期限）ので、audit の例外の面では単独で進められる。P1（C-query の worker `nir1-c-query-worker` を package に同梱し、Main が解決した絶対 path を Native に渡す。spawn の経路は開けず、Graph の公開 gate は閉じたまま。判断の記録は [cp2b-decisions.md](nir1-lane-decisions/cp2b-decisions.md)）は #721 で merge 済み（`0f63fc03`）。P2〜P4 は当時未着手（次の追記のとおり P2・P3 は merge 済み）。worker の同梱で install 後のディスクは約 90 MB 増える（installer と更新 zip は gzip で約 3.2 MB 増）。ユーザーはそのまま進める判断をした（§1 の SB-14、SB-15）。2026-10-26 追記（後続）: P3（H1）は #726（`6a8907d9`）で merge 済み。更新経路の定期 CI `update-route-watch.yml`（週 1 回＋`workflow_dispatch`）と検知 script `scripts/update-route-redirect-check.mjs`、updater の error の試験、実 Electron の harness を足した。検知だけで RS-1 は変えない。初回の `workflow_dispatch`（run 40247119143）は hosted で成功。P2 は #728（`10f7db66`）で merge 済み。3 OS の packaged smoke（Negative (34)）の harness `electron/scripts/packaged-smoke/*.mjs` と `.github/workflows/packaged-smoke.yml`、判定、Linux の試運転の記録（`docs/plans/nir1-lane-decisions/cp2b-p2-linux-trial/`。G-pub の証跡ではない）。PR の run（head `a2802934`）の hosted の結果は、Linux／macOS／Windows とも (34) は pass（RJ の不合格 0、NL 合格、toolcheck の食い違い 0）。macOS は `.local` が unverified（ベースラインで UDP 5353 の問合せを観測できない。K3/3 :283 により未検証として記録、PUB-G の開示の残余〔K3/3 :314〕）で、127.0.0.2 に bind できず 6 行が canary 不可。判断を要した開示は PR 本文（form の shim、keyring の marker、worker の env 名と Windows の console window は未観測）。P4（G-pub の記録）は、master `10f7db66` の SHA を候補に `packaged-smoke.yml` を `workflow_dispatch` した（run 40256736959、3 OS）。結果の記録の PR は別。G-pub の記録は候補の head に束縛されるので、PUB-G の最終候補では採り直す |
| CP-4 | G-01〜G-08、24件、P の計測と A3 consumer activation の証跡 | 未指定 | CP-3a／b の後。計測窓で行う。X1-2 と X1-3 の merge、CQ-LIM-4（G-03 の再 freeze。Graph の観測の前）、観測前の commit（K2/4 の addendum。Graph arm の最初の観測の前）が開始条件（詳細は §10.4）。現状: X1-2／X1-3（#670、#674）、CQ-LIM-4（#678）、CP-3a／b（#698、#700）は満たした。残るのは観測前の commit と計測窓。CP-3a の申し送り（DR-CP3A-53、55）: 製品ではほぼ常に graph-late になる見込みで、検証だけで release の db の median 6.6 ms 対 D の窓 10.84 ms。lease 越しの end-to-end は未実施で、CP-4 の可用性判断の主な入力になる。2026-10-25 追記: CP-4 の診断（Graph が製品の通常の経路でほぼ使えない原因は、begin 自身の監査の commit が worker の registration／query の `ReadIdentity` の drift と衝突すること。DR-CP4-S1C2-19〜22。記録は統合 branch `claude/nir1-cp4` の `cp4-decisions.md` にあり、master にはまだ無い）への、監査・鮮度・保存の契約を変えない対処として、D′（CQ-DEFER。Related Scenes の Graph の query を begin 自身の commit の後まで保留する）が #715（`4d38d0d1`）で master に入った。決定の記録は [cq-deferred-decisions.md](nir1-lane-decisions/cq-deferred-decisions.md)。K6/2 の (a)（窓内率）は D′ でも構造上 HOLD（結果は常に graph-late）。(a) を通す手段は 3 つある: 合流の経路の短縮（実装の最適化。契約と閾値は変えない）、再 query の cache の結果を可用性に数える新しい K6 の draftRef、監査まわりの変更（C 案＝別 DB、spool など。重要な変更でユーザーの確認が要る）。実 Electron での確認 (ii) は integrator の builder が実行中（統合 branch `claude/nir1-cp4`。未 push）。残るのは観測前の commit と計測窓、(ii) の結果。2026-10-26 追記（Session B5。§10.7）: (ii) と H5（製品の hook を通した実現可能性の診断）は統合 branch で取られた（`claude/nir1-cp4` の `d7521a12`。DR-CP4-S1C2-27、28）。RS-JOIN（合流の短縮。`claude/nir1-join-opt`、製品の PR は #722 で未 merge）でも子の Graph は D の窓にほとんど届かない（5/60。DR-RSJ-8、9）。ユーザーは「K6/2はAで」（§1 の SB-12）で再 query の cache の結果を可用性に数える案を選び、K6/4（`nir1-final-request-eval-proposal/4#graph-eval-procedure`）が 2026-10-26 に確認された。批准 6 の (i) により、条件が成立しない間の CP-4 の可用性は、表示の可用性の欠落率（first-render の窓内か、`graph-ready` の取り直しの follow-up の成功。物差し 1%、定常状態は全 case の pool）で判定し、first-render の窓外率は記録と開示だけにする（T_late 100 ms、W_f 100 ms、T_show 2 s。最初の表示の D=10.84 ms は変えない）。ただし緩和を当てられるのは、D′、取り直しで一覧を保つ hook（RS-JOIN。PR #722）、W_f を製品に入れる変更（批准 12）をすべて含む候補だけで、後の 2 つが master に入るまで CP-4 の可用性は HOLD のまま。次の製品の変更は、批准 12（子〔`graph-ready` を契機にした取り直しの世代〕の合流にだけ W_f を渡し、子の合流は 1 回だけ公開し、契機の印と渡した窓の値を `timing` に出す。親の D、子の IR の deadline、ほかの契機の query は変えない）で、確認の後に別 lane で独立レビューと試験を経て行い、RS-JOIN の hook の上に置く。CP-4 の正式の窓の前に、/4 の凍結（`claude/nir1-contracts`）、G-case の seed の pin の照合（R5。凍結の前の前提）、W_f を入れた候補での診断（条件の判定に使わない）、runner と分類器の変更（R1〜R8、F1〜F7、X1〜X13、K6/4-N1〜N40 の合成の記録）が要る（K6/4 の draft の「引き継ぎ」H1〜H5）。(ii) は条件の成立と改めての確認の後にだけ効く。2026-10-26 追記（後続）: W_f の製品の変更（批准 12）は #725（`c4333bbd`、WF-WINDOW）で master に入った。`graph-ready` を契機にした取り直し（子）の合流にだけ Graph の窓 W_f=100 ms を渡す。D=10.84 ms、IR の deadline、親の合流は不変。製品は `timing` を読まない。実測（dev fixture。診断であり評価の証拠ではない）は、子が Graph を受けて公開した割合が 4/30 から 30/30 と 29/30。RS-JOIN の hook（#722）と W_f（#725）が master にそろったので、K6/4 の「CP-4 の可用性は W_f と RS-JOIN の hook が master に入るまで HOLD」の条件は満たされた。実際の評価（S5）はユーザーに評価専用 build の件を伝えてから行う。測定の harness の変更は統合 branch `claude/nir1-cp4`（未 push）にあり、master には無い。2026-10-27 追記（SP/1。§10.8）: 開始条件に、SP/1 の addendum（G-case の全 variant の問いの場面への seed の pin）を観測前の commit に入れ、R5 の照合（`assertSeedPinsBeforeK64`）が match になることを加える。SP-P4 の診断（pin が R と R+IR を変えないことの実測）は評価の前に取る |
| PUB-G | Graph の公開 | integrator | Session C-1 の承認後。K3/3 の G-pub（3 OS の packaged smoke で Negative (34)）が通ってから。K3/3 の確認は PUB-G と開示の文言を承認しない。現状（2026-10-25）: Session C-1 は未承認で、Graph の公開は閉じたまま |
| DD-1、PUB-L | local 送信の製品入口と公開 | DD-1 は未指定、PUB-L は integrator | Session C-2 の承認後に PUB-L。DD-1 の保留（K3/3 の引き継ぎ H4。K6/2 の DD-1 の分類と K3/3 が加えた「続く通信」の2項目の両立）は、2026-10-25 の K6/3（`nir1-final-request-eval-proposal/3#nir1-final-request-packing-eval`）の確認で解けた（§10.6）。DD-1 は K6/2 の行と同じ通常の依存（K3/2、K4/3、K5/3 の実装、Session C-2 の承認など）で着手でき、K6/3 の型・件数・記録の規則と受入れ（K6/3-P1〜P3、N1〜N30）に従う。現状（2026-10-25）: DD-1 は未着手。PUB-L は Session C-2 の承認が要り、未承認。2026-10-26 追記: DD-1-0 の試走は完了した（結果は K6/3 の上限の内。評価環境は IPv6 なしに固定する方針）。DD-1a は実装中。2026-10-26 追記: DD-1a は #727（`7508e139`）で master に入った。local 生成の Native 入口（6 つの `#[napi]` command、Native gate `PrePublicationEntry::LocalGeneration`＝既定で閉、同一 capture の 2 回目の start の拒否、取消の結束、会話の印＝`chat_sessions.id` の予約接頭辞 `nir1-local-{writing,review}-<uuid>`）。TS 側の IPC は未変更。lifecycle／security の独立レビュー（Opus）を 2 回ずつ行い、P2（starter thread の panic で handle が漏れる、E7b・E9 が owner の停止を固定していない）は修正済み。判断の記録は [dd1a-decisions.md](nir1-lane-decisions/dd1a-decisions.md)（DR-DD1A-1〜27）。次は DD-1b（TS 側: ipcContract の 6 command、NAPI_COMMANDS、restricted-only の区分、Main の gate、sender の destroyed／window close を cancel sender に結ぶ、key の判定）|
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

NC-1（K3/3 の実装。2026-10-18 に追加）は DA-1 の開放 commit の前に merge する（開放 commit は NC-1 の merge と G-open の後）。NC-1 は #683 で merge 済みで、開放 commit は #690 で merge 済み（2026-10-19 のユーザーの指示）。DA-1 の ST1・ST2・ST4 と ST3 の開放の前は #676 で先に merge 済みなので、列の DA-1 を2つに分けた。CB-2 など他の lane との前後は、準備できた順に入れ替えてよい。

CQ-LIM-1〜4（proposal/7 の実装。2026-10-17 に追加）は、X1-3 の merge の後の再測を終えてから merge するので、列では DI-1b の後、CP-4 の前に置いた（実際は 2026-10-18 に #678 で merge 済み）。列は準備できた順に入れ替えてよい（下記）が、CQ-LIM-4 は CP-4 の G-03 の観測の前に終える。CQ-LIM-1〜3 の merge と CP-4 の順序は CP-4 の TASK.md を作るときに integrator が決めて記録する（proposal/7 の draft に定めがない）。X1-2／X1-3／X1-4（X1/1。2026-10-17 に確認済み）はこの列に置いていない。CB-1 と並行に作り、後に merge する側が先に入った側の試験を通す。§6 の列では CP-3a が CB-4 の前にあるが、§4 の依存は CP-3a／b に CB-4 の merge を求めるので、CP-3a の merge は CB-4 の後でよい。

2026-10-26 までの merge の実績（squash commit。#691 より後の行は merge の順に並べた。#699 は #698 より先に merge した）:

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
| #685 | docs の同期（#679〜#684 の merge を索引と現在地に反映。docs だけ） | `0619a346d21eb2f8cdf7c4b7ecdfe64a0131b8f1` |
| #686 | CB-4（Graph-only Scene の候補の走査と本文を読まない判定、click 時の再検証） | `bb4f098e84f6628e4f9c660822e3909503b5d7dd` |
| #687 | X1-4（Scene Scope 投影の受入れ journey を実 Electron で通す） | `990876853296ebe2deb5d5d25982e14710f22626` |
| #688 | DI-1a（D-final の Graph 材料の要求・待ち・再資格化） | `b4738c50eeea76ef3fda588094a8707af6f74c57` |
| #689 | DI-1b（history の最終予算と、再認可を通った history だけを最終 request に入れる） | `bf69e2f00a3b68e23059431cd931e2a86e4b2cbe` |
| #690 | DA-1 の開放 commit（`own-data-read` を有効にする。ユーザーが 2026-10-19 に指示。G-open の記録は開放 commit の head `d91c24f1` で採り直した） | `95414be8352ca41c7d28af3341a820fb0419874c` |
| #691 | downloadGuard の temp 削除待ちを固定待ちから条件待ちにする試験の修正（NIR-1 の lane ではない） | `d468bb4c1fe9843d99f777a6371d491e84217132` |
| #695 | audit の high／critical の解消（storybook 10.6.3、markdown-it 14.3.3、vite 8.3.5、rustls-webpki 系。NIR-1 の lane ではない） | `1818bbc80a04ebb2b9dc156aaa6892cddea436a3` |
| #693 | docs の同期（第5陣と DA-1 の開放 commit の索引・現在地・台帳。docs だけ） | `82d1ae6d8d88481eec8fda5016b0a8134d81b525` |
| #694 | X1-4 の契約試験を registry と分類に登録する | `d79a42bc148be7ad1ace8d564ac2b94976317f1e` |
| #696 | CB-3（宣言の UI と宣言の状態の read 入口。gate が閉じている間は見えない） | `8a1ed2522306e80eb8d61dd8241ffb97bf176f4b` |
| #699 | audit の high の解消（Electron 43.8.3 と NC-1 の記録の採り直し。NIR-1 の lane ではない） | `18df360f81913eb0065863a91a44ace714c10ec2` |
| #698 | CP-3a（Related Scenes に Graph を接続する wire・IPC・合流の土台。公開は閉じたまま） | `5fb19295d91a59de043d0d518ca19e10c408579b` |
| #700 | CP-3b（Related Scenes の Graph を renderer に載せる。公開は閉じたまま） | `060752632fd9686c07c1ccb4815f07a15b293ecd` |
| #702 | DA-2a（D2a の activation の機構。起動入口は gate で閉じたまま） | `fff4fefa2040705ec780ef9617ec1fff2bf1ad6e` |
| #706 | DA-2b（typed Native writer 9 command〔CW 5・M 3・T 1〕、`isD2aEgressDenied` の 9 箇所の見直し、W-1） | `4dd583ee9ad80f44df0f3088935c3ee26e406def` |
| #707 | docs の同期（#696〜#706 の索引、現在地、台帳、運用メモ。docs だけ） | `7af0be933acc8e8943c2fb18001bdf760a2c582c` |
| #708 | `http-cache-semantics` を 4.3.0 に上げ、GHSA-ch52-4w7c-c8xp の pnpm audit 例外を外す（NIR-1 の lane ではない） | `6101146ba784d69a532c87612a7eb8a36a2ae8cd` |
| #709 | DP-H S0（contract と JS の gate を fixture の版の表で扱う。置換版〔版2〕の fixture は未作成） | `352474d4cbeb6fe590b02f1f0b0c7298f2662f09` |
| #710 | ProduceSkia の根本原因の修正（復元後の reload を WebGL の面が display から外れてから行う。NIR-1 の lane ではない） | `800d411783c428a7f03dfc9f5922d739f5027ff8` |
| #711 | K6/3 の確認の台帳取り込みと確認規則の緩和（U8。docs だけ） | `6c7c2d00bf2cbede5dab14ee278cb9e9321cf0fe` |
| #712 | DP-H S0c（契約と harness に unknown Scope の拒否 variant を足し、gate を版 2 に対応させる） | `e2d22b89c92b9de9585d273349e516e9df6ee5b7` |
| #713 | DP-H 版 2 の fixture と freeze（S1〜S3。独立期待値 review の後に freeze） | `d1cc8cb44fb036a5fc2b5dde5bbfb2d2e066eb05` |
| #714 | DP-H S4 の前の mechanics 確認（unknown Scope の拒否 variant と setup の検査を D-final を含む経路で確かめる） | `6592b71b4de4ffc55c7a00338d91961c373bc3c9` |
| #716 | 外部送信の送信前の監査 commit を停電にも耐える commit にする（NIR-1 の lane ではない） | `a0bd88da4f95d0f7cad4e886befd6814c17fd8d2` |
| #715 | D′（CQ-DEFER。Related Scenes の Graph の query を begin 自身の commit の後まで保留する） | `4d38d0d164e02a76a0e172214b259a11e0b2c5ff` |
| #717 | チャット入力の下書き保存（再起動・再 mount の後に戻す。NIR-1 の lane ではない） | `bdc892d7dd1d3d87b59c72b4f25434b7bd71162d` |
| #718 | docs の同期（#708〜#717 と 2026-10-25 の実態。docs だけ） | `e68aa45c29d9397b6026aa84a1538a0933bca454` |
| #719 | 旧 shell の updater の zip feature を外し、cargo audit の zip の例外を解消する（NIR-1 の lane ではない） | `ac9b417892e9d20fa5b1440e901a0de35e1b12b1` |
| #720 | DA-2b の PUB-G 前の必須 1（PR-A。場面の会話でない会話の「編集して再送」を、定数に依らず状態の読取で閉じる） | `c87bd446a0b7813711f92d67ecd3bba445c72957` |
| #721 | CP-2b P1（C-query の worker を package に同梱し、Main の解決した path を Native に渡す。公開 gate は閉じたまま） | `0f63fc0379a3ce3d561c87ea075ebc25ad34f0a7` |
| #722 | Graph の合流の短縮（RS-JOIN。lane の並行化、Native の起こし、`graph-ready` の取り直しで一覧を保つ hook） | `870242052e18f03dc04bb37e80b649de66dd69fc` |
| #723 | K6/4 の確認（Session B5）の台帳取り込みと続行計画への記録（docs だけ） | `16797ce780e7f4b5115717a619ce03b007e2c58b` |
| #724 | DA-2b の PUB-G 前の必須 3・4（PR-B。AI の入口の閉鎖を定数 `PROFILE_ACTIVATION_UI_ENABLED` の後ろで広げ、送信の閉鎖を 3 状態にする） | `8e93bb315502812558513b01fadd98c41c29ac52` |
| #725 | WF-WINDOW（K6/4 の批准 12。`graph-ready` を契機にした取り直しの合流にだけ Graph の窓 W_f=100 ms を渡す） | `c4333bbd081fb297cf2dddc598155791b9678be8` |
| #727 | DD-1a（local 生成の Native 入口。6 つの `#[napi]` command、Native gate は既定で閉。TS 側の IPC は未変更） | `7508e1394511435057d41d50733f84fbd3c407df` |
| #726 | CP-2b P3（更新経路の redirect 先の host を RS-1 と照合する定期 CI。検知だけ） | `6a8907d9e0b2a8142f33e86b9cd51991fdc041e2` |
| #728 | CP-2b P2（3 OS の packaged smoke〔Negative (34)〕の harness と workflow） | `10f7db66612ad000da130567ae209907bf1a45c0` |

master の canonical Full は `a789039a` で green だった（run 39102745768、基点 `01238cfc`）。その後、`a8ee82d5`（#683）で green（run 39150424373）。`95414be8`（#690）の run 39267874715 も green だった。その後の green は、`1818bbc8`（#695）の run 39974725686（基点 `95414be8`）、`5fb19295`（#698。CB-3、CP-3a、Electron 43.8.3 を含む最初の Full。full-runtime も success）の run 40064179881（基点 `1818bbc8`）、`fff4fefa`（#702）の run 40098332275（基点 `5fb19295`）、`4dd583ee`（#706）の run 40134006607（基点 `fff4fefa`）である。最後の green は `4dd583ee`（#706）。2026-10-25 追記: その後 `6101146b`（#708）の run 40159735430 が green で、これが当時の最後の green だった。#709（`352474d4`）の master の Full（run 40162280197）は、当時は結果待ちだった（結果は次の追記）。#691、#693、#694、#696、#699、#700 の merge 単独の Full は取っていない（次の green の Full が含む）。#706 の最初の Full（run 40129066249）は `full-journeys` の shard 2 の `chat-stream-workspace-switch`（console.error `[EditorPane] sceneLoad.loadAnchors:authorshipSpans failed`）で赤になった。`gh run rerun --failed` では journey が green になっても `full-aggregate` が part artifact の名前（attempt 名）で落ちたので、同じ候補（基点 `fff4fefa`、head `4dd583ee`）で新規に dispatch して green の run 40134006607 を得た。Full の flake は rerun でなく、同じ候補での新規 dispatch で取り直す。#680〜#684 の merge の順は #681、#682、#680、#683、#684 で、PR 番号の順と違う。DT-5、HC-1、CB-2、DI-1c の4レーンの PR と NC-1 は、[nir1-lane-decisions の README](nir1-lane-decisions/README.md) の索引の衝突を避けるため、索引の行を足さずに merge し、後の docs の同期の PR（`claude/nir1-sync2`）で足した。CB-4、X1-4、DI-1a、DI-1b、DA-1 の開放 commit（#686〜#690）も同じく索引の行を足さずに merge し、docs の同期の PR（`claude/nir1-sync3`）で足した。CB-3、CP-3a、CP-3b、DA-2a、DA-2b（#696、#698、#700、#702、#706）も同じく索引の行を足さずに merge し、docs の同期の PR（`claude/nir1-docs-sync-20261025`。2026-10-25）で足した。

2026-10-25 追記（#708 以降の master の Full。run の結論と head は `gh run view` で確かめた。基点は `bdc892d7` の run だけが `d1cc8cb4` と分かっており、ほかの基点はこの同期では確かめていない）: `6101146b`（#708）の run 40159735430 は green、`352474d4`（#709）の run 40162280197 は green、`800d4117`（#710）の run 40166558036 は green。`e2d22b89`（#712）の run 40173122243 は `full-runtime` の `longTask 107ms` で red だった。runner の負荷の flake と判断し、同じ候補で新規に dispatch した run 40175430888 は green。`d1cc8cb4`（#713）の run 40177838563 は green。`bdc892d7`（#717）の run 40189485528 は green（基点 `d1cc8cb4`）。最後の green の Full は `bdc892d7`。docs だけの #711 は Full を取っていない（800d4117 に含まれない docs のみ）。#714、#715、#716 の merge 単独の Full は取っていない（`bdc892d7` の Full が含む）。2026-10-26 追記: 最後の green は `bdc892d7`（run 40189485528）のまま。#718〜#721 の master の Full はまだ取っていない（まとめて 1 回取る予定）。 2026-10-26 追記（後続）: `7508e139`（#727）の run 40246865226 は `full-journeys` の `cross-feature-authoring`（editor did not hold focus before undo）で赤だった。flake と判断し、再 dispatch した run 40251145474（head `6a8907d9`、base `87024205`）は green。最後の green の Full は `6a8907d9`（#724〜#727 を含む。#728 は Full 未実施）。次の Full の `candidate_base` は `6a8907d9`。PR の flake（`rerun --failed` で通った）: runtime perf の `longTask` 108 ms（上限 90）と `coldStartMs` 5895 ms（上限 4000）、product journeys の `nir1-scene-scope-projection-acceptance`（トーストが pointer event を奪う click timeout）、`c2-5b-interrupted-run-recovery`、`chat-stream-codex-switch`。

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
| `claude-nir1-sync2`（再利用） | `claude/nir1-sync3` | `d468bb4c`（`origin/master`） | 第5陣と DA-1 の開放 commit の docs の同期（#693。docs だけ。PR の base は rebase 後の `1818bbc8`） |
| `claude-nir1-x1-4`（再利用） | `claude/nir1-reg3` | `d468bb4c`（`origin/master`） | X1-4 の契約試験の登録（#694。PR の base は rebase 後の `82d1ae6d`） |
| `claude-nir1-cb4`（再利用） | `claude/nir1-cb3` | `d468bb4c`（`origin/master`） | CB-3（#696。PR の base は rebase 後の `d79a42bc`） |
| `claude-nir1-di1b`（再利用） | `claude/nir1-cp3a` | `d468bb4c`（`origin/master`） | CP-3a（#698。PR の base は rebase 後の `18df360f`） |
| `claude-nir1-di1b`（再利用） | `claude/nir1-cp3b` | `5fb19295`（`origin/master`） | CP-3b（#700） |
| `claude-nir1-cb4`（再利用） | `claude/nir1-da2a` | `5fb19295`（`origin/master`） | DA-2a（#702。PR の base は rebase 後の `06075263`） |
| `claude-nir1-cb4`（再利用） | `claude/nir1-da2b` | `fff4fefa`（`origin/master`） | DA-2b（#706。ST4-A、ST4-B の統合、ST5-B、W-1 の取込み、受入れ） |
| `claude-nir1-da2b-ui` | `claude/nir1-da2b-ui`、`claude/nir1-da2b-w1` | `claude/nir1-da2b` の途中の commit（`3a5b42dd` を含む） | DA-2b の ST4-B（renderer。`claude/nir1-da2b` に ff した）と W-1 の再設計（2 commit を `claude/nir1-da2b` に cherry-pick した）。2026-10-25 に片付けた |
| `claude-nir1-cb4`（再利用） | `claude/nir1-docs-sync-20261025` | `4dd583ee`（`origin/master`） | #696〜#706 の docs の同期（docs だけ） |
| `claude-pnpm-hcs` | `claude/pnpm-hcs-bump-20261025` | `7af0be93`（`origin/master`） | `http-cache-semantics` 4.3.0（#708。NIR-1 の lane ではない）。merge 済み・片付け可（`git status --ignored` を確かめてから） |
| `claude-skia-root` | `claude/skia-rootcause-20261025` | `352474d4`（`origin/master`） | ProduceSkia の根本原因の修正（#710。NIR-1 の lane ではない）。merge 済み・片付け可（`git status --ignored` を確かめてから） |
| `claude-nir1-dph-s0` | `claude/nir1-dph-s0` | `7af0be93`（`origin/master`） | DP-H S0（#709）。merge 済み・片付け可（`git status --ignored` を確かめてから） |
| `claude-nir1-k6-3` | `claude/nir1-k6-3` | `7af0be93`（`origin/master`）。HEAD は K6/3 の確認された版 `ee4d5be2` | K6/3 の draft（merge しない branch で SHA を固定。内容は #711 に byte 同一で取り込み済み）。片付け可（`git status --ignored` を確かめてから） |
| `claude-nir1-k6-3-ledger` | `claude/nir1-k6-3-ledger` | `352474d4`（`origin/master`） | K6/3 の台帳取り込みと確認規則の緩和（#711。docs だけ）。merge 済み・片付け可（`git status --ignored` を確かめてから） |
| `claude-nir1-dph-s0c` | `claude/nir1-dph-s0c` | `6c7c2d00`（`origin/master`） | DP-H S0c（#712）。merge 済み・片付け可（`git status --ignored` を確かめてから） |
| `claude-nir1-dph-s1` | `claude/nir1-dph-v2` | `e2d22b89`（`origin/master`） | DP-H 版 2 の fixture・review・freeze（S1〜S3。#713。worktree 名は S1 のまま branch は `claude/nir1-dph-v2`）。merge 済み・片付け可（`git status --ignored` を確かめてから） |
| `claude-nir1-dph-s4pre` | `claude/nir1-dph-s4pre` | `d1cc8cb4`（`origin/master`） | DP-H S4 の前の mechanics 確認（#714）。merge 済み・片付け可（`git status --ignored` を確かめてから） |
| `claude-nir1-dph-s4` | （detached。HEAD は `6592b71b`） | `6592b71b`（`origin/master`） | DP-H S4（版 2 の evidence の実行。DR-DPH-120。merge しない）。run directory など ignore 対象に実行の成果物が残っていないかを `git status --porcelain --ignored` で確かめてから片付ける |
| `claude-nir1-cp4-s1b` | `claude/nir1-cp4-s1b` | `7af0be93`（`origin/master`） | CP-4 S1b の診断。未 merge（統合 branch `claude/nir1-cp4` の祖先であることを確かめた）。片付けの可否はこの同期では決めていない |
| `claude-nir1-cqdefer` | `claude/nir1-cq-defer` | `6592b71b`（`origin/master`） | D′（CQ-DEFER。#715）。merge 済み・片付け可（`git status --ignored` を確かめてから） |
| `claude-audit-dispatch-fsync` | `claude/audit-dispatch-fsync` | `6592b71b`（`origin/master`） | 外部送信の送信前の監査 commit を停電にも耐える commit にする（#716。NIR-1 の lane ではない）。merge 済み・片付け可（`git status --ignored` を確かめてから） |
| `claude-chat-draft` | `claude/chat-draft-persist` | `6592b71b`（`origin/master`） | チャット入力の下書き保存（#717。NIR-1 の lane ではない）。merge 済み・片付け可（`git status --ignored` を確かめてから） |
| `claude-docs-sync-b` | `claude/docs-sync-20261025b` | `bdc892d7`（`origin/master`） | #708〜#717 の docs の同期（本書と `dp-h-decisions.md`。docs だけ） |
| `claude-nir1-cb4`（再利用。**使用中**） | `claude/nir1-cp4` | `bdc892d7`（`origin/master`） | CP-4 の統合 branch（未 push）。warm な cargo の builder で、D′ の実 Electron での確認 (ii) を実行中。片付けない |
| `claude-docs-sync-c` | `claude/docs-sync-c` | `10f7db66`（`origin/master`） | #722〜#728 の docs の同期（本書。docs だけ） |

`origin/master` の基点はいずれも `a153743b3f672b7274bdd748f15ef9c216dc9961`（#629）。`claude-nir1-dt2` は 2026-10-12 23:17 JST に、`claude/nir1-dt1` の DT-1 commit `3688a0633537818e80a88e40f056604ffa496e8a` から作った。`claude-nir1-dt3` は 2026-10-12 23:34 JST に、同じ DT-1 commit `3688a0633537818e80a88e40f056604ffa496e8a` から作った。`claude-nir1-cp1` は 2026-10-13 00:11 JST に、`claude/nir1-cres` の CR-1b commit `0e041537e8c56c43be38afea490c26857bb488a7` から作った。`claude-nir1-broute` は 2026-10-13 00:47 JST に `origin/master` の `a153743b` から作った（SPIKE S1 で、製品に B の sealed binding を publish する経路が無いことが分かったため、B-ROUTE レーンを追加した）。`claude-nir1-crrec` は 2026-10-13 22:07 JST に `origin/master` の `dabbed14711561693b0a86de0241873a9beafa04`（#649）から作り、CR-1 の merge の後に、その squash commit `750741183cf4d75ccf18b3904a5751b762284bda`（#636）へ載せ替えた。作成時刻は各 branch の reflog（`git reflog show --date=iso <branch>`）の作成記録で確かめた。以後に作る worktree は、作成時に本表へ追記する。merge 済みのレーンの worktree は、この計画で作ったものに限って片付ける。

`claude-nir1-crrec` より後の行は、DOC-REC（2026-10-14）でまとめて追記した。作成時刻（JST）は各 branch の reflog の作成記録で確かめた：`claude/nir1-cp2a` 10-13 22:13、`claude/merge-gate-quick` 22:27、`claude/nir1-cr2` 23:03、`claude/ci-pin-c2zc-base` 23:34、`claude/flaky-runtime-sampler-pid` 10-14 01:47、`claude/nir1-cqopt` 02:13、`claude/journey-idempotent-create` 02:23、`claude/flaky-x` と `claude/flaky-y` 04:34、`claude/nir1-bguard` 10:13、`claude/nir1-x1a` 12:20、`claude/nir1-cqavail` と `claude/nir1-cqmem` 12:36、`claude/nir1-docrec` 14:10。

2026-10-14 に、merge 済みのレーンの worktree を片付けた。対象は、HEAD が merge 済みの PR の head と一致し、追跡されるファイルに未 commit の変更が無いものに限った。12:25 に `claude-ci-pin`、`claude-flaky-sampler`、`claude-flaky-x`、`claude-journey-create`、`claude-merge-gate`、`claude-nir1-broute`、`claude-nir1-cp0`、`claude-nir1-cp1`、`claude-nir1-cp2a`、`claude-nir1-cr2`、`claude-nir1-cres`、`claude-nir1-crrec`、`claude-nir1-dt1`、`claude-nir1-dt2`、`claude-nir1-dt3`、`claude-nir1-hp` を、13:17 に `claude-flaky-y` と `claude-nir1-cqopt` を片付けた（時刻は会話記録の timestamp）。branch は残した。このとき、gitignore の対象（`.ralph/`）に置かれていた lane の判断記録（DT-1、DT-2、DT-3、CR-1、HP-1、CP-1、B-ROUTE の `.ralph/agent/decisions.md`）も一緒に消えた。消えた記録は会話記録から復元し、§3.3 の記録先に置いた。以後は、worktree を片付ける前に `git status --porcelain --ignored` で ignore 対象を確かめ、記録を退避してから消す。

`claude-nir1-b3-record` より後の行は、docs の同期（`claude/nir1-sync2`。2026-10-19）でまとめて追記した。作成時刻（JST）は各 branch の reflog の作成記録で確かめた：`claude/nir1-measure` 10-17 12:08、`claude/nir1-df-plus`・`claude/nir1-dt4`・`claude/nir1-x1-2` 14:31、`claude/nir1-cb1`・`claude/nir1-cq-lim`・`claude/nir1-da1`・`claude/nir1-dp-h` 19:18、`claude/nir1-x1-3`・`claude/nir1-hs1` 20:31、`claude/fix-graph-oversized-flake` 22:51、`claude/nir1-webrtc-proto` 10-18 02:08、`claude/nir1-dt5`・`claude/nir1-hc1`・`claude/nir1-cb2`・`claude/nir1-di1c` 13:01、`claude/nir1-nc1` 19:24、`claude/nir1-sync2` 10-19 03:29、`claude/nir1-cb4`・`claude/nir1-di1a`・`claude/nir1-di1b`・`claude/nir1-x1-4` 03:30。U5（CI 保守。計画外）の worktree は載せない。merge 済みのレーンの worktree は、この時点ではまだ片付けていない。

`claude-nir1-x1-4` より後の行は、docs の同期（`claude/nir1-docs-sync-20261025`。2026-10-25）でまとめて追記した。作成時刻（JST）は branch の reflog の作成記録で確かめた：`claude/nir1-sync3`・`claude/nir1-reg3`・`claude/nir1-cb3`・`claude/nir1-cp3a` は 10-23 21:32（`d468bb4c` から）、`claude/nir1-da2a` は 10-24 13:54（`5fb19295` から）、`claude/nir1-da2b` は 10-24 22:31（`fff4fefa` から）。`claude/nir1-cp3b` と、`claude/nir1-da2b-ui`・`claude/nir1-da2b-w1`（片付けで削除した）には、確かめられる作成記録が残っていない。CB-3 以降の lane は、warm builder の `claude-nir1-cb4`（cargo の target を持つ）と `claude-nir1-di1b` を、branch を替えて再利用した。2026-10-25 に `claude-nir1-da2b-ui` と、その branch の `claude/nir1-da2b-ui`・`claude/nir1-da2b-w1` を片付けた（`git status --porcelain --ignored` で ignore 対象がビルド成果物だけであることを確かめた）。`claude-nir1-di1b` は 2026-10-25 の時点で存在しない（`git worktree list` と `~/worktrees/Grimodex/` に無い。消した時期の記録は無く、確かめられない）。`claude-nir1-cb4` は次の lane の warm builder として残す（次の lane は `origin/master` から新しい branch を切る。`claude/nir1-da2b` は squash 済みで master の祖先ではない）。U5（CI 保守。計画外）の branch〔`claude/audit-pnpm-20261023`、`claude/audit-electron-zod-20261024` ほか〕は載せない。

`claude-pnpm-hcs` より後の行は、docs の同期（`claude/docs-sync-20261025b`。2026-10-25）でまとめて追記した。base は、各 branch と `origin/master` の merge-base を `git merge-base` で確かめた値で、branch の作成時の基点とは限らない（rebase や同期の後の値を含む）。branch の作成時刻は、この同期では確かめていないので書かない。merge 済みと書いた branch は、対応する PR の squash commit が `origin/master` にある（§6）。片付ける前に、§12.2 のとおり `git status --porcelain --ignored` で ignore 対象を確かめる。`claude-nir1-cp4-ctl`（branch `tmp/cp4-dprime-control`）は、この同期の依頼の一覧に無かったので載せていない。

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
| DD-1 | K6 の確認者が、K6/2 の DD-1 の分類と K3/3 が加えた「続く通信」の2項目の両立を判断した後（K3/3 の引き継ぎ H4。契約の条件ではない integrator の運用）。2026-10-25 追記: H4 は K6/3 の確認で解けた（§10.6） | 両立しなければ K6 の新しい draftRef を起案する（2026-10-25 追記: K6/3 として起案され、確認された） |

2026-10-19 追記（#679〜#684 の merge の後。上の記録と表は直さない）:

- Session B3 の記録は #679（`7c3d3110`）で master に入った。
- NC-1 は #683（`a8ee82d5`）で master に入った。判断の記録は [nc1-decisions.md](nir1-lane-decisions/nc1-decisions.md)（DR-NC1-1〜49）。G-open の記録は Linux の実機で採った（[`nir1-lane-decisions/nc1-g-open/`](nir1-lane-decisions/nc1-g-open/README.md)。採取時の head は `fd549d4c`、Electron 43.5.0）。Windows／macOS と packaged の build は G-pub（CP-2b）の範囲で、この記録に含まない。採取時の head の製品コードと harness が master と同一であることは、PR の時に git diff で確かめた。この同期で `fd549d4c` と `b8a0bb7c` の差を見直した結果: NC-1 の module（`electron/main/rendererContainment*.ts`。試験を除く）と harness（`electron/scripts/webrtc-block-probe*`）には差が無い。ただし `electron/main` の全体では、NC-1 より先に merge した CB-2（#682）の MG-1 の配線（`index.ts`、`ipc.ts`、`mainGrant.ts`、`bodyDeclarationCiSeam.ts`、`profileEgress.ts`）とその試験の差がある。DR-NC1-46 (b) の検査（`git diff <記録の head> HEAD -- electron/main electron/scripts/webrtc-block-probe*` が空）は字義のままでは満たさないので、この差の扱い（再走するか、閉じ込めに影響しないことを確かめるか）を開放 commit の PR で決める。
- DA-1 の開放 commit（ST3。`own-data-read` を有効にする commit）の前提は、NC-1 の merge、G-open の記録、master の canonical Full の green である。NC-1 の merge と G-open の記録は満たした。master の Full は `a8ee82d5` まで green（run 39150424373）で、`b8a0bb7c` の Full（run 39154324262）は実行中（この記録の時点）。開放 commit は未実施で、実施の前にユーザーの確認を得る。開放の後も、PUB-G と Session C-1（Graph の公開、activation UI の公開、開示の文言）は別の承認である。

### 10.6. Session B4（K6/3）

| 項目 | 値 |
|---|---|
| 受信 | 2026-10-25（JST。integrator が 13:47 ごろに処理した。正確な受信時刻は会話記録の timestamp）。ユーザー自身が打ったメッセージで、1文だけのメッセージ。draft の「確認文」の節の文と1字違わない |
| 確認された版 | branch `claude/nir1-k6-3` の commit `ee4d5be29ba7033acbf77febc6a8a11cef216a12` の `docs/plans/nir1-final-request-eval-proposal-3-draft.md` |
| 取り込み | `git show <commit>:<path>` の出力をそのまま置いて byte 同一で取り込み、`sha256sum` が下の値と一致することを確かめた。「Status: draft／未確認」の行を含めて本文は編集せず、確認状態は確認台帳で表す。K6/2 の bytes は変えていない |
| 確認の前の経緯 | DD-1 は K3/3 の引き継ぎ H4 により着手を保留していた。ユーザーは 2026-10-25 に案 A（K6 の新しい版 /3 を起案する）を選んだ（§1 の SB-8。確認文ではない） |

| 略称 | ファイル | SHA-256 |
|---|---|---|
| K6/3 | [nir1-final-request-eval-proposal-3-draft.md](nir1-final-request-eval-proposal-3-draft.md)（329行） | `2ae123d2319bb0246045bebc39d2391add15deccfa0aa58d87dbfce3b8ecbf2b` |
| K6/2（参考。変えない） | [nir1-final-request-eval-proposal-2-draft.md](nir1-final-request-eval-proposal-2-draft.md) | `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8` |

ユーザーが打った1文（逐語。draft の「確認文」と1字違わない）:

```text
I confirm draftRef nir1-final-request-eval-proposal/3 for contractId nir1-final-request-packing-eval.
```

- この文は、`nir1-final-request-packing-eval` の行だけを確認する（確認台帳の Confirmation protocol）。確認されるのは、draft 冒頭の「ユーザーが批准すること」の1〜9だけである（範囲の正本。台帳は別の列挙を持たない）: 1 期待された通信に (a) LS-1 への接続、(b) blackhole された辞書の要求の試み、(c) datagram を送らない IPv6 の到達性の確認の UDP connect を型と起点つきで加える、2 加え方の制約（DP-1 の証跡は NC-1 を当てた起動に限る）、3 LS-1 の port の同定、4 件数・時刻・記録の規則（M_a = 1、N_b ≤ 3、N_c ≤ 2、ε ≤ 100 ms、capture mode）、5 これが K6/2 の文面より弱い読み（合格基準の緩和）であること、6 版の番号の読み替え、7 変えないもの、8 許さないもの、9 threat model と受入れ。K6/2 の 147 行の規則で、/3 の行は K6/2 の行を全体として supersede する。
- 「判断を求める点」の5点は、draft の規則（推奨のまま確認文を打てば推奨が確認される）により、推奨が確認された: 1 N_b の上限は 3、2 DP-1 の証跡にする run は NC-1 を当てた起動に限る、3 置換版を版2、DD-1 の版を版3 と読む、4 capture mode は `--net-log-capture-mode=Everything`、5 (c) を型つきで加える（K3/4 の代案は採らない）。ユーザーは代案を述べていない。
- 許可しないもの（批准 8）: DD-1 の実装と実行そのもの、DP-H の置換版の作成そのもの、NC-1 の挙動の変更、新しい authority・保存先・送信先・製品の入口・評価専用の入口、Graph と local 送信の公開、Session C-2 の承認。依存する契約（K3/3 を含む）と K6/2 の条件付きの2行（`g01-eval-revision`、`graph-eval-procedure`）は確認されず、条件未成立のまま。
- 解除: DP-H は置換版（版2）の fixture を置ける（S1。K6/3 の「変える点」の 14 に従い、`supersedes` で失効した版1を引き、新しい材料だけで作り、作者と独立期待値 reviewer を版1 の作者・実装者と S0 の実装者から分ける。DR-DPH-89）。DD-1 は H4 の保留が解け、K6/2 の行と同じ通常の依存で着手できる。DD-1 は最初に診断の run を取り（K6/3 の引き継ぎ D1）、止める条件（N_b > 3、N_c > 2、M_a ≠ 1、挨拶の書込みの event が現れない）に当たれば `[precheck]` で止まり、K6 の新しい draftRef を求める。
- 台帳の更新箇所: 確認台帳の 2026-10-25補足（Session B4。B4-1 の表、「1文の範囲」、「K6/3 が許さないもの」）、`nir1-final-request-packing-eval` の /3 の行（K6/2 の行の下。K6/2 の行は消していない）、K6/2 の 2026-10-17 の注の下の「変える点」1〜15 の読み替えの注、K3/3 の行の備考と K3/3 の引き継ぎの注への H4 の解決と DR-DA2-44 の IPv6 の分類の注記、lane snapshot の DD-1 と DP-H の行。`nir1-lane-decisions/dp-h-decisions.md` の DR-DPH-89。
- この記録で行わないこと: DD-1 と DP-H の TASK への K6/3 の写し（lane の開始時に行う）、DD-1 の harness と /3 を受ける validator の実装、置換 fixture の作成。

### 10.7. Session B5（K6/4）

| 項目           | 値                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 受信           | 2026-10-26（JST。integrator が 00:41 に処理した。正確な受信時刻は会話記録の timestamp）。構造化質問（AskUserQuestion）への回答                                                                                                           |
| 形式           | 確認台帳の Confirmation protocol（2026-10-25 の緩和の後。§1 の U8）の構造化質問の形: 質問の文が `draftRef`、`contractId`、draft の SHA-256 を名指し、ちょうど1つの `draftRef#contractId` を示した。選ばれた選択肢は明示の確認            |
| 示した ref     | `nir1-final-request-eval-proposal/4#graph-eval-procedure`（draftRef `nir1-final-request-eval-proposal/4`、contractId `graph-eval-procedure`）                                                                                            |
| 確認された版   | branch `claude/nir1-k6-4` の commit `18ebc7b8de2d4f2701c573b5d91561a6cc852024` の `docs/plans/nir1-final-request-eval-proposal-4-draft.md`（329行）                                                                                      |
| 取り込み       | `git show <commit>:<path>` の出力をそのまま置いて byte 同一で取り込み、`sha256sum` が下の値と一致することを確かめた。「Status: draft／未確認」の行を含めて本文は編集せず、確認状態は確認台帳で表す。K6/2 と K6/3 の bytes は変えていない |
| 確認の前の経緯 | K6/2 の (a) は D′ の下で構造上 HOLD だった。ユーザーは 2026-10-25 に「K6/2はAで」と指示した（§1 の SB-12。起案の指示で、確認文ではない）。確認を求めるときに、H5 と RS-JOIN の結果（批准 11）を添えた（所在は確認台帳の 2026-10-26補足） |

| 略称                   | ファイル                                                                                            | SHA-256                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| K6/4                   | [nir1-final-request-eval-proposal-4-draft.md](nir1-final-request-eval-proposal-4-draft.md)（329行） | `d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3` |
| K6/2（参考。変えない） | [nir1-final-request-eval-proposal-2-draft.md](nir1-final-request-eval-proposal-2-draft.md)          | `4ccca08314c022fd969308fa969e6fcb3e2c439fe12757bfec0e901b905676f8` |
| K6/3（参考。変えない） | [nir1-final-request-eval-proposal-3-draft.md](nir1-final-request-eval-proposal-3-draft.md)          | `2ae123d2319bb0246045bebc39d2391add15deccfa0aa58d87dbfce3b8ecbf2b` |

integrator の質問（逐語。integrator の伝える文）:

```text
K6/4 の draft（draftRef `nir1-final-request-eval-proposal/4`、contractId `graph-eval-procedure`、SHA-256 `d205b35f71da6db3fe94ae881e1e500941090a8261b95343a3a50def5f6323c3`、329 行、branch `claude/nir1-k6-4` の `docs/plans/nir1-final-request-eval-proposal-4-draft.md`、冒頭の「あなたが決めること」は 3 行）を、推奨のまま確認しますか？ 確認すると、(1) 関連場面の一覧に Graph の根拠が「最初の表示と同時に」出ることを合格の条件から外し、(2) 取り直しで Graph を待つ新しい基準 W_f=100 ms（最初の表示の 10.84 ms は変えない）を置き、(3) 実際の操作の評価でも取り直しで出た Graph を数え、あわせて T_late 100 ms、T_show 2 s、欠落率 1%（全 case の pool）、品質を取り直しの表示で測ること、が承認の直後から CP-4 の判定に使われます（合格基準の緩和。製品の変更〔W_f を取り直しに渡す〕と RS-JOIN の hook〔PR #722〕が入るまで、CP-4 の可用性は HOLD のままです）。
```

選択肢（逐語）:

- 「推奨のまま確認する」（推奨。説明: 「上の 3 点と、ほかの 5 点〔T_late 100 ms、T_show 2 s、1%、品質の測り方、承認の直後から使うこと〕を、この draft〔SHA-256 `d205b35f…23c3`〕のとおり確認します。確認の記録は台帳に取り込む別の PR で行います。」）
- 「一部を変えて確認したい」
- 「まだ確認しない」

ユーザーの回答（逐語）:

```text
推奨のまま確認する
```

- この回答は、`graph-eval-procedure` の /4 の行だけを確認する（確認台帳の Confirmation protocol）。確認の範囲は、draft 冒頭の「ユーザーが批准すること」の1〜12の全項目（範囲の正本。台帳は別の列挙を持たない）。/4 の行の内容は、K6/2 の `graph-eval-procedure` の本文の全文に /4 の「変える点」の1〜18を当てたもの。
- 効力は2段（批准 6）: (i) /4 の行のうち (ii) 以外のすべて（批准 1〜5、7〜12、「変える点」の1〜18、threat model の加算、受入れの K6/4-P1〜P3 と K6/4-N1〜N40、R1〜R8、技術点 1〜3、変えていない K6/2 の本文）は**確認**され（`confirmedRef` を持つ）、記録の時点から「条件が成立しない場合の CP-4 の可用性」（K6/2 の 612 行）の判定に使う。(ii) K6/2 の 614 行の Delta、620 行の Lane unlocked、621 行の受入れへの影響に /4 の読み替えを当てたものは、条件の成立と改めての確認の後にだけ効く事前の確認で、効力の根拠にしない。
- 「判断を求める点」の1〜8と技術点 1〜3 は、draft の規則（推奨のまま承認すれば推奨が確認される）により、推奨が確認された: 1 first-render を合否から外す、2 W_f = 100 ms（新しい閾値）、3 T_late 100 ms、4 T_show 2 s、5 欠落率の物差し 1%（定常状態は全 case の pool）、6 G-case の品質を follow-up の表示でも測る、7 効力は2段、8 (b) でも follow-up を数える（(ii)）。ユーザーは代案も追記も述べていない。
- 合格基準の緩和（5点。批准 5）は draft の自己評価のとおり: (1) Raw と同時に Graph が届くことを、通知が T_late 以内に届き製品の再 query で T_show 以内に表示されることで代替、(2) 子の Graph の窓を D から W_f に広げる、(3) 品質を子の表示でも測り、case の HOLD の条件を替える、(4) (b) でも follow-up を数える、(5) 子の結果の出所の記録を counter と begin の記録からの推論で代える。最初の表示の D=10.84 ms、lease 100 ms、1%、「遅れた結果は既に公開した合流に混ぜない」は変えない。緩和は、D′ の状態機械、取り直しで一覧を保つ hook（DR-RSJ-6 と同等）、W_f を製品に入れる変更（批准 12）をすべて含む候補に限る。
- 許可しないもの（批准 9）: この確認そのものによる製品のコードの変更（批准 12 の変更は確認の後に別 lane で行う）、批准 12 のほかの製品の変更を K6/4 の名で行うこと、最初の表示の D の値の変更、G-case の fixture と setup の変更（seed の pin を含む）、新しい authority・保存先・送信先・製品の入口、Graph の公開（PUB-G）と Session C-1 の承認、条件の成立の判定そのもの。この確認は、Graph の製品公開、local 送信の公開、activation UI の公開（PUB-G、PUB-L、Session C-1／C-2）を許可しない。依存する契約と、K6/2・K6/3 のほかの contractId の行（`nir1-final-request-packing-eval`、`g01-eval-revision`）は確認されない。
- 解除されないもの: CP-4 の可用性は、批准 5 の候補（D′ は #715 で master、RS-JOIN の hook は PR #722 で未 merge、批准 12 の W_f の変更は未実装）がそろうまで HOLD のまま。/4 の凍結、G-case の seed の pin の照合、W_f を入れた候補での診断も未実施（§11）。
- 台帳の更新箇所: 確認台帳の 2026-10-26補足（Session B5。B5-1 の表、「承認の範囲と効力」、「K6/4 が許さないもの」）、`graph-eval-procedure` の /4 の行（/2 の行の下。/2 の行は消していない）、/2 の行の備考への /4 の読みの追記、K6/2 の 2026-10-17 の注の下の「変える点」1〜18 の読み替えの注、K6/2 の条件付きの2行の注（`confirmedRef` を持たない）の下の 2026-10-25 以降の注（K6/4。/4 の (i) には当てない）、lane snapshot の CP-4 の行。Confirmation protocol は変えていない。
- この記録で行わないこと: 批准 12 の製品の変更、/4 の凍結（`claude/nir1-contracts` への commit と事前登録の凍結の記録）、CP-4 と W_f の lane の TASK への K6/4 の写し（lane の開始時に行う）、G-case の seed の pin の照合、CP-4 の runner と分類器の変更。`nir1-lane-decisions/` の記録（DP-H を含む）には触れていない（K6/4 は DP-H、DD-1、K6/3 に影響しない。draft の「範囲と他の lane への影響」）。

### 10.8. Session B6（SP/1）

| 項目           | 値                                                                                                                                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 受信           | 2026-10-27 06:47 JST（integrator が伝えた確認の日時。正確な受信時刻は会話記録の timestamp）。構造化質問（AskUserQuestion、1 回）への回答                                                                                                  |
| 形式           | 確認台帳の Confirmation protocol（2026-10-25 の緩和の後。§1 の U8）の構造化質問の形: 質問が `draftRef`、`contractId`、draft の SHA-256 を名指し、ちょうど1つの `draftRef#contractId` を示した。選ばれた選択肢は明示の承認                  |
| 示した ref     | `nir1-graph-case-seed-pin-proposal/1#graph-case-seed-pin-setup`（draftRef `nir1-graph-case-seed-pin-proposal/1`、contractId `graph-case-seed-pin-setup`）                                                                                                                                      |
| 確認された版   | branch `claude/seed-pin-draft` の commit `8ff7b848a676969feaaac6033d84ed6987e2334c` の `docs/plans/nir1-graph-case-seed-pin-proposal-1-draft.md`（238行）                                                                                                       |
| 取り込み       | `git show <commit>:<path>` の出力をそのまま置いて byte 同一で取り込み、`sha256sum` が下の値と一致することを確かめた。「Status: draft／未確認」の行を含めて本文は編集せず、確認状態は確認台帳で表す。K6/4、K6/2、K2/4 の bytes は変えていない |
| 確認の前の経緯 | K6/4 の R5 は seed を製品の規則で決めて評価の前に照合することを求め、批准 9 は seed の pin を「CP-0 の側」に置いた。凍結した G-01〜G-08 の問いの場面には pin が無く、照合は 8 組すべてで一致しなかった。SP/1 は integrator の指示で起案された（ユーザーがこの問題について選択肢を選んだ記録は、この質問より前には無い） |

| 略称 | ファイル                                                                      | SHA-256                                                            |
| ---- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| SP/1 | [nir1-graph-case-seed-pin-proposal-1-draft.md](nir1-graph-case-seed-pin-proposal-1-draft.md)（238行） | `8ccdf5345a50ab710a61039e8abd09803086bef3f8337bb83667ea9274b4e547` |

integrator の質問（要旨。integrator の伝える内容。質問の文の逐語は会話記録にあり、ここには転記していない）:

```text
draftRef nir1-graph-case-seed-pin-proposal/1、contractId graph-case-seed-pin-setup、SHA-256 8ccdf5345a50ab710a61039e8abd09803086bef3f8337bb83667ea9274b4e547 を名指し、次を説明した。G-01〜G-08 の問いの場面に予定した起点の人物への pin を 1 つずつ、凍結したファイルを変えず評価の準備の手順（別ファイル）で足す。製品のコードは変えない。コードを読んだ限り Raw／IR／Graph の選び方は変わらない（integrator が引用箇所で確認、実測は評価の前）。G-01 も同じ扱いで、元の設計書の「pin は 1 つだけ」の文を問いの場面の pin についてだけ読み替える。足した pin を使う評価の run は照合と独立 reviewer のレビューの後に限る。効力は承認の直後から。
```

選択肢（逐語）:

- 「推奨のまま承認する（G-01 を含む）」
- 「G-01 を外して承認する」
- 「承認しない（pin を足さない）」

ユーザーの回答（逐語）:

```text
推奨のまま承認する（G-01 を含む）
```

- この回答は、`graph-case-seed-pin-setup` の SP/1 の行だけを確認する（確認台帳の Confirmation protocol）。確認の範囲は、draft 冒頭の「ユーザーが批准すること」の 1〜8 の全項目（範囲の正本。台帳は別の列挙を持たない）: 問いの場面への pin の追加（選択肢 A）、G-01 の読み替え（判断 2）、変えないもの、段の置き場と記録・受入れ（SP-P1〜SP-P5、SP-N1〜SP-N14）・観測前に固定するもの、threat model、K6/4 の R5 の照合、止める条件、許さないもの。
- 効力は承認の直後から（条件の成立を待つ部分は無い）。ただし、足した pin を使う評価の run は、R5 の照合と、観測前の commit（独立 reviewer のレビューつき）の後に限る。
- 影響を受ける既存の確認済みの行（K6/4、K6/2 の `g01-eval-revision`／`graph-eval-procedure`、K2/4）は変更しない。
- これは Graph の公開（PUB-G）や Session C-1 の承認ではない。
- 台帳の更新箇所: 確認台帳の 2026-10-27補足（Session B6。B6-1 の表、「承認の範囲と効力」、「SP/1 が許さないもの」）、`graph-case-seed-pin-setup` の新しい行（/4 の行の下）、K6/4 の注の下の 2026-10-27 の注 2 つ（K6/4 の批准 9 の「CP-0 の側」の受け皿が SP/1 であること、候補 §7 の :219-220 と :237 の読み替え）、lane snapshot の CP-4 の行（開始条件に SP/1 の addendum と R5 の照合の match を追加、TASK に SP/1 の設計・受入れ・reviewer に見せるものを写す）。Confirmation protocol は変えていない。
- この記録で行わないこと: addendum の file の作成と観測前の commit、R5 の照合（`assertSeedPinsBeforeK64`）の実行、SP-P4 の診断、K6/4 の凍結、CP-4 の TASK への写し（lane の開始時に行う）、製品のコードの変更。

## 11. 未解決事項

- `[precheck]` DT-2 の再試行の上限（sweep の recover の再試行 0 回→最大2回、送信していない終端の書込みの再試行 1 回→最大3回。K1b の規則7の再確認の対象）の再確認は、Session B1 の9文のどれにも含まれず、未解決である。手段は DSN §9 のとおり（新しい draftRef を起案するか、1件1回への締め直し）。台帳の残 HOLD 表の D-transport の行（DT-1〜3）からここへ向ける。
- `[policy]` `.agents/skills/bump-version/SKILL.md` の手順9（97行目）は、release commit の Full に、ローカルの `pnpm ci:local:full -- --base "$release_base" --head "$release_head"` を指示したままである。Full admission が標準の GitHub-hosted job 以外を拒否するとした更新後の [GDX-TRACE-001](../../policies/quality/iron-laws.md#GDX-TRACE-001) と食い違う。release flow は G0 の範囲外（U5 の CI 保守に近い）なので、G0 では skill を編集しない。次の release の前に、hosted の canonical Full への読み替えを別に扱う。
- proposal/7 の実装（CQ-LIM-1〜4）の merge 条件（X1-3 の merge の後の再測を終えること）は、2026-10-18 に満たされた。最初の再測が §10.4 の条件（registration の使用量が Q の 85% を超える）を割って `[precheck]` で止まり、ユーザーが「まず実装で直す（推奨）」を選んで（§1 の SB-7）実装で解消し（DR-CQL-13）、proposal/8 は不要だった。CQ-LIM-1〜4 は #678 で master にある。
- CQ-LIM-1〜3 の merge と CP-4 の順序は、proposal/7 の draft に定めがなかった。CQ-LIM-1〜4 は CP-4 の前に #678 で merge 済みで、CQ-LIM-4（G-03 の再 freeze）も済んだ。CP-4 の TASK.md を作るときに、観測前の commit が引く freeze の sha256（`6080530adc0a7d2d45896005664f6f498d5f28c3eeed517875f8f599faa8bae7`）を確かめる。
- 取り込んだ K2/4 の K2/3 への link は切れたままである（bytes を変えない）。
- `[precheck]` DA-1 の ST3 の開放 commit（`own-data-read` を有効にする commit）は、K3/3 の確認で設計が確定し、NC-1 は #683 で master に入り、G-open の記録（Linux の実機）もある。解消済み（2026-10-23 の同期）: ユーザーが 2026-10-19 に「DA-1 の own-data-read を有効にする」と指示し、開放 commit は #690 で merge 済み。G-open の記録は開放 commit の head `d91c24f1` で採り直した（DR-DA1-36）。canonical Full は run 39267874715 で green。PUB-G と Session C-1 は別の承認のまま。
- 解決済み（2026-10-25）: K3/3 の引き継ぎ H4 は、K6/3（`nir1-final-request-eval-proposal/3#nir1-final-request-packing-eval`）の確認で解けた（§10.6）。DD-1 の保留は解け、DP-H は置換版を版2 として置ける。以下は当時の記述: K3/3 の引き継ぎ H4: K6/2 の DD-1 の分類が、K3/3 が「続く通信」に加えた2項目（Chromium から LS-1 への接続と、blackhole された辞書の要求の試み）を「一覧の項目への試み」として扱えるか、K6/2 の「loopback の接続の試みは、一覧に項目がないのですべてそれ以外」とする文面と両立するかは、K6 の確認者の判断のまま残る。DD-1 の着手の前に決める（契約の条件ではない integrator の運用。照合では済ませない）。両立しなければ K6 の新しい draftRef を起案する。
- K3/3 の引き継ぎ H2: 止めた辞書の自動取得の代わり（Main 側での取得、同梱、取得先を exact host に固定する案）は、未検証で別の draftRef が要る。別の課題として残る。
- K3/3 の引き継ぎ H1: 更新経路の定期 CI（公開 release の asset の redirect 先の host が RS-1 に含まれるかの週1回の CI と、RS-1 起因の更新の失敗が updater の error として surface されることの試験）は CP-2b の担当が決める（条件ではない。新しい workflow を要する）。
- DT-5 の引き継ぎ（#680。[dt5-decisions.md](nir1-lane-decisions/dt5-decisions.md)）: (1) 主要な local server（llama.cpp の server、Ollama、LM Studio、vLLM、SGLang）の実測（K5/3 の DT-5a）は未実施（DR-DT5-13、27）。model の重みの取得は新しい外部通信とディスクの消費になるので、委任の外として行っていない。数値の確定（DR-DT5-26）は draft の初期案のままで、実測の根拠を持たない。(2) Windows の `SO_RCVTIMEO`／`SO_SNDTIMEO` の timeout の後の socket の状態は、Winsock の文書では不定である（DR-DT5-30。未解決。安全性ではなく Windows での成功率の問題）。(3) 取消の close と join の有界性は 3 OS の手当て（DR-DT5-24）を入れたが、macOS の CI の経路が無く、macOS では実行されていない。(4) `Nir1LocalGenerationInput.config` が `pub(crate)` のままである。(5) DD-1、PUB-L、integrator への引継ぎは decisions 文書の末尾のとおり。
- HC-1 の引き継ぎ（#681。[hc1-decisions.md](nir1-lane-decisions/hc1-decisions.md)）: (1) 1 turn の予算の数値は integrator が K1b の規則5で決める（HC-1 は production code に固定値を足していない）。(2) HC-1a の実測の推奨値は DR-HC1-12 にある。(3) SQL VM steps、deadline、busy の枯渇と cancel は、run が部分的な outcome を返せず型付き error になる。この扱いは DI-1b と integrator への申し送り（DR-HC1-24）。
- DI-1c の引き継ぎ（#684。[di1c-decisions.md](nir1-lane-decisions/di1c-decisions.md)）: (1) Revision・Decision・Freshness の変更が、再観測の後から claim の COMMIT の前までに入ると、旧い request が1回送られる（残余。DR-DI1C-9 の A-18 の観測）。(2) Native 選択の可用性の上限（513 件／約 34 件）。(3) 旧い claim の API が `pub` のまま残る。
- CB-2 の引き継ぎ（#682。[cb2-decisions.md](nir1-lane-decisions/cb2-decisions.md)）: (1) workspace 不一致の message が絶対 path を含む。(2) 取消は半端な行（JSON 列だけが入り token 列が NULL の行）を消さない（DR-CB2-1 の追記）。(3) D2a の epoch の変化の `revoke_all` の順序（DR-CB2-10）。(4) Windows／macOS では locator が未実行。(5) 高リスクの判断（DR-CB2-3、-4）の advisor の結論は、decisions 文書では「未取得（integrator の作業）」のままである。
- NC-1 の引き継ぎ（#683。[nc1-decisions.md](nir1-lane-decisions/nc1-decisions.md)）: (1) K3/3 の引き継ぎ H1〜H11 の扱いは DR-NC1-40 のとおり（G-pub と H7 の所要の記録は CP-2b、H11 は記録の `verdicts.txt` で不活性の行を列挙。ほかは実装に触れない）。(2) 実行中の失敗の webContents の破棄は、同期の破棄が Electron 43.5.0 で SIGSEGV するため、handler の外の次の tick で行う（DR-NC1-18。draft の FC-1 の「その場で破棄」との差）。(3) G-open の記録は採取時の head に束縛され、`electron/main` か harness の変更で無効になる。検出は開放 commit の PR の git diff で行う（DR-NC1-46 (b)。§10.5 の 2026-10-19 追記）。(4) DR-NC1-46 (c) で未解決とした `chat-stream-workspace-switch` と、未実行だった C2-ZC の journey は、canonical Full で確認済み。
- DP-H の引き継ぎ（#677。[dp-h-decisions.md](nir1-lane-decisions/dp-h-decisions.md)）: 2026-10-25 追記: evidence は S4 で PASS した（DP-H 単体。DR-DPH-120。DP-1 の証跡でも P-12 の証跡でもない）ので、次の「HOLD のまま」は #677 の時点の記述である。evidence は HOLD のまま（DR-DPH-75）。(1) 置換 fixture の担当と版が未定である。(2) gate の `FIXTURE_PATH`／`FREEZE_PATH` が版 1 に固定されている。(3) freeze record の commit 数の上限が 16 である。2026-10-25 追記: (2) は #709（DP-H S0）で版の表に改めた。(1) の版は K6/3 の確認で版2 に定まった（担当は未定。DR-DPH-89）。2026-10-25 追記 2: (1) の担当は S1〜S3 で決まり（#713）、版 2 の fixture は freeze 済みで、S4 の evidence は PASS した（DR-DPH-120）。この PASS は DP-1 の証跡でも P-12 の証跡でもない（`dp1Evidence: false`、`p12: not-measured`）。
- 期限（2026-10-25 に確認）: (1) journey の ProduceSkia 警告の一時的な CI 例外（`electron/scripts/product-journey-harness.mjs` の `expiresOn`）は 2026-11-10 に失効する。再延長は根本原因の修正が前提である（同じ箇所の reason に "no further extension without a root-cause fix" とある）。2026-10-25 追記: 根本原因の修正は #710 で merge 済み。例外をまだ残している理由は、修正後の ProduceSkia 警告 0 を数 run 確認するため。確認できたら別 PR で例外を削除する。延長しない。2026-10-31 追記: 例外を削除する PR を作った（#710 の後の CI の 8 run〔PR CI と master の push・schedule〕の log で実際の ProduceSkia 警告は 0。該当した行は単体試験の固定の見本行だけだった）。期限 2026-11-10 の例外は、この PR の merge で無くなる。(2) cargo audit の zip 4.6.1（RUSTSEC-2026-0367〜0369。frozen legacy の Tauri shell の `tauri-plugin-updater` だけが引く。`.cargo/audit.toml`）の例外は 2026-11-18 00:00 JST に失効する。pnpm audit の GHSA-ch52-4w7c-c8xp（http-cache-semantics）の例外は、#708 で恒久解消した（`http-cache-semantics` 4.3.0 に上げ、`scripts/pnpm-audit.mjs` の例外のコードを外した）。残る期限は cargo の zip（2026-11-18）と (1) の ProduceSkia（2026-11-10）である。失効すると PR CI の Security が全 PR で失敗する。11 月上旬に延長か恒久対応を決める。恒久対応は重要な変更ではない（§12.1）ので自動で進めてよい。ただし cargo の zip については、2026-10-25 追記: ユーザーの判断が要る（updater の zip feature を外す〔frozen の旧更新経路に触れる〕か、延長か）。延長するときは期限と理由を記録し、最終報告で知らせる。lock を更新する PR は `scripts/local-ci-full-workload-allocation.json` の 2 つの Cargo.lock の sha256 も更新する。例外が解消されれば CP-2b を単独で進められる。解消されなければ PUB-G に同梱し、Session C-1 でリスク判断を求める。2026-10-26 追記: (2) の cargo の zip の例外は、ユーザーの指示「旧シェルのzip featureは外しましょう」（§1 の SB-13）により、#719（`ac9b4178`）で解消した（frozen legacy の旧 shell の `tauri-plugin-updater` を `default-features = false`、`features = ["rustls-tls"]` にして zip とその固有の依存を `src-tauri/Cargo.lock` から外し、`.cargo/audit.toml` の zip の例外と期限を外した。`ignore` は空。`scripts/local-ci-full-workload-allocation.json` の sha256 も同じ PR で更新した）。2026-11-18 の期限は不要になった。上の「残る期限は cargo の zip（2026-11-18）と…」「11 月上旬に延長か恒久対応を決める」「cargo の zip については…ユーザーの判断が要る」は当時の記述である。残る期限は (1) の ProduceSkia（2026-11-10）だけで、pnpm と cargo の audit の例外はどちらも無い。CP-2b は audit の例外の面では単独で進められる。
- CB-3 の引き継ぎ（#696。[cb3-decisions.md](nir1-lane-decisions/cb3-decisions.md)）: v1 の制限と記録のみの P3 は DR-CB3-31、34 にある（json 列だけの half-state は UI から直せない、再読取のたびに 5 軸の確認が消える、ほか）。宣言の UI は `BODY_DECLARATION_UI_ENABLED=false` で閉じている。開けることは重要な変更（§12.1）。
- CP-3a／CP-3b の引き継ぎ（#698、#700。[cp3a-decisions.md](nir1-lane-decisions/cp3a-decisions.md)、[cp3b-decisions.md](nir1-lane-decisions/cp3b-decisions.md)）: (1) 製品ではほぼ常に graph-late になる見込み（DR-CP3A-53）。CP-4 の可用性判断の主な入力。可用性を上げる手段（`current_operation` と検証を 1 本にする、Revision の評価の共有、検証の前倒し）は CP-4 の測定を見て判断する。D と 100 ms は緩めない。(2) lease 越しの end-to-end（Eligible の行を `graph_continue` で受け取り、その handle で `nir1_evidence_qualify` を呼んで click する流れ）は未実施（DR-CP3A-32、55）。PUB-G と CP-4 の実機で最初に通す。(3) PUB-G の前提条件と申し送りは cp3b-decisions.md の末尾の「引継ぎ」のとおり。
- D′（CQ-DEFER。#715。[cq-deferred-decisions.md](nir1-lane-decisions/cq-deferred-decisions.md)）の位置づけと残り（2026-10-25）: CP-4 の診断（Graph が製品の通常の経路でほぼ使えない原因は、begin 自身の監査の commit が worker の registration／query の `ReadIdentity` の drift と衝突すること。DR-CP4-S1C2-19〜22）への、監査・鮮度・保存の契約を変えない対処である。(1) K6/2 の (a)（窓内率）は D′ でも構造上 HOLD（結果は常に graph-late）。(a) を通す手段は、合流の経路の短縮（実装の最適化。契約と閾値は変えない）、再 query の cache の結果を可用性に数える新しい K6 の draftRef、監査まわりの変更（C 案＝別 DB、spool など。重要な変更でユーザーの確認が要る）。(2) 実 Electron での確認 (ii) は integrator の builder が実行中（統合 branch `claude/nir1-cp4`。未 push）で、結果はまだ無い（2026-10-26 追記: (ii) と H5 は取られた〔`claude/nir1-cp4` の `d7521a12`。DR-CP4-S1C2-27、28〕。(1) の「再 query の cache の結果を可用性に数える新しい K6 の draftRef」は K6/4 として確認された。§10.7 と次の項）。(3) 監査の扱いについてのユーザーの発言と、Opus の 3 視点の結論は §1 の U9。メモリ上の queue と spool は重要な変更で、進めていない。外部送信の送信前の監査 commit を停電にも耐える commit にする対処は #716 で入った。
- K6/4（`nir1-final-request-eval-proposal/4#graph-eval-procedure`。2026-10-26 に確認。§10.7）の残り（draft の「確かめられなかったこと」と「引き継ぎ」による。どれも確認の条件ではない）: (1) W_f を製品に入れる変更（批准 12。子の合流にだけ W_f を渡し、子の合流は 1 回だけ公開し、契機の印と窓の値を `timing` に出す）は未実装で、確認の後に別 lane で行い、独立レビューと試験を要する。RS-JOIN の hook の上に置く。(2) RS-JOIN の製品の PR #722 の merge と (1) が master に入るまで、批准 5 の候補が無く、CP-4 の可用性は HOLD のまま。(3) G-case の各 query の Scene の最初の pin が事前の期待値の seed と一致することの照合（R5）は、/4 の凍結の前の前提で、取れなければ K6/4 の判定を始めず CP-0 と `g01-eval-revision` の側で扱う（DR-CP4-S1C2-26 は dev fixture だけを確かめた）。(4) /4 の凍結（`claude/nir1-contracts` への commit と push、K6/2 の「事前登録の凍結」の 1〜7 の記録）は未実施で、条件の判定に使う診断と (i) で判定する CP-4 の run は凍結の後に始めたものに限る。(5) 確かめられなかったこと: G-case での子の Graph の到着と W_f の余裕（H5 と RS-JOIN は dev fixture）、W_f を入れた候補での follow-up の率、編集の最中の follow-up、D-final との cache の競合と待ちの延び、同じ project の 2 つの表示の往復、`t_notice` の clock の差の内訳、遅い begin（1,704.6 ms、1,157.0 ms、子の 837.3 ms）の原因と頻度、評価の手順のファイルの置き場所と版の名前、判断 8 の (ii) の下での閲覧中の trace の表示の率、前の sample の ticket が R2 の後に cache を埋める並びの頻度。(6) 次に要る診断は、W_f を入れた候補で、できれば G-case に近い fixture で子の到着と follow-up の率を見るもの（条件の判定に使わない）。CP-4 の正式の窓の前に取り、W_f の内に収まらない見込みが強ければ integrator に返す（H5）。(7) CP-4 の runner の変更（R1 の待ち、hook の消費者、timing shim、R7 の記録、K6/4-N1〜N40 の合成の記録。H1）と、評価の JSON への counter の出力（H2。新しい製品の入口は足さない）。(8) 統計の幅: 欠落率 1% の判定は pool が 240 件なら欠落 2 件までを許し、真の欠落率が 1% でも PASS の確率は約 57%（draft の平文の要約）。PUB-G の開示（Session C-1）に添える。
- DA-2a／DA-2b の引き継ぎ（#702、#706。[da2-decisions.md](nir1-lane-decisions/da2-decisions.md)、[da2b-renderer-decisions.md](nir1-lane-decisions/da2b-renderer-decisions.md)）: (1) PUB-G／Session C-1 の前に必須（da2b-renderer-decisions.md 冒頭の表の 1、3、4）: 場面の会話でない会話の「編集して再送」が `PROFILE_ACTIVATION_UI_ENABLED` の定数が false の間も restricted の profile では DB の行を消す（定数に依らない閉鎖が要る。案 (i) は DR-DA2-29 の逸脱の批准と起動時 graph の予算の判断が要る）、AI の入口の UI の閉鎖が chat panel だけ、閉鎖の文言が会話の無い場面の scope では偽。(2) W-1 の新しい文言 `profileEgress.writeRetry.failed` は Session C-1 で承認が要る。W-1 の起動時 graph 0 byte は builder の chunk の分け方に依存する（静的試験と予算で守る）。(3) feature 付きの cargo 試験は Quick の `impact` stage でだけ走る。Full の `rust` stage に載せるなら `scripts/local-ci-registry.json` と `scripts/local-ci-full-workload-allocation.json` を変える。(4) 2 つ目の Backend の `shutdownWorkspaceLifecycle` が戻らない（テスト環境のみ。原因は未調査）。(5) 読めない状態ファイルのとき `dialog.showErrorBox` が Native の文をそのまま出す。PUB-G の前に扱う。(6) 実 Electron の restricted で通らなかった（未検証の）typed writer は、CW4（メッセージの削除。UI から menu を開けなかった）、Label、Prompt template、pin の子の切替、baseline の CAS、snapshot の作成と削除、chat を含む import である（DR-DA2B-R11 (a)）。このうち Label、Prompt template、pin の子の切替は、renderer の関数を実 router と実 Native に通す spec（`electron/main/d2bRendererWriters.pipeline.spec.ts`。DR-DA2B-R11 (b)）で担保した。CW4、baseline の CAS、snapshot、import は、renderer の呼び出しを実 router に通した試験が無い（Native と Main の側は ST4-A の試験の範囲。DR-DA2-50〜53、61）。
- 2026-10-26 追記（DA-2b の PUB-G 前の必須。[da2b-renderer-decisions.md](nir1-lane-decisions/da2b-renderer-decisions.md) の冒頭の表）: 件 1 は PR-A として #720 で閉じた（DR-DA2B-R17、R18）。件 3・4 は PR-B で実装中だった。**PUB-G を止める項目**（冒頭の表の行 5。PR-A の独立レビューの P1-1）: 場面の会話でも、route が capture の外なら、restricted で「編集して再送」が行を消す。閉じていない。Session C-1 でユーザーに確かめる。 2026-10-26 追記（後続）: 件 3・4 は PR-B として #724 で merge 済み。DA-2b の PUB-G 前の必須 3 件は master にそろった。PUB-G の前提で残るのは、起動時 JS の予算の緩和（定数 true で 4,252,464、現在の上限 4,251,000）、owner Suspended の復帰の配線、上の PUB-G を止める項目（Session C-1 でユーザーに確かめる）、C-1 の文言の承認。
- worker の固定 heap の縮小（後続の課題。CP-2b P1 の #721 で同梱した `nir1-c-query-worker` は約 91.5 MB で、うち約 84 MB は固定 heap が実行 file に入っているため。install 後のディスクは約 90 MB 増える）: heap を実行時の確保に直して縮める。C-resource の受入れの対象なので、変えるときは審査が要る。ユーザーは同梱をそのまま進める判断をした（§1 の SB-15）。
- 2026-10-26 追記（後続。#722〜#728 の merge の後の残り）: (1) DD-1b（TS 側: ipcContract の 6 command、NAPI_COMMANDS、restricted-only の区分、Main の gate、sender の destroyed／window close を cancel sender に結ぶ、key の判定）。(2) CP-4 の S5（K6/4 の批准 5 の候補は #715、#722、#725 で master にそろった。評価専用 build の件をユーザーに伝えてから行う）。(3) CP-2b P4（G-pub の記録。master `10f7db66` を候補にした `packaged-smoke.yml` の run 40256736959〔3 OS〕の結果の記録は別 PR）。PUB-G の最終候補では採り直す。(4) PUB-G の前提（上の DA-2a／DA-2b の追記）。(5) ProduceSkia の例外の期限 2026-11-10（削除する。延長しない）。(6) macOS の `.local` は unverified（#728）。PUB-G の開示の残余（K3/3 :314）。
- SP/1（`nir1-graph-case-seed-pin-proposal/1#graph-case-seed-pin-setup`。2026-10-27 に確認。§10.8）の残り（draft の「確かめられなかったこと」による。どれも確認の条件ではない）: (1) pin が R と R+IR を変えないことの実測（SP-P4 の診断。今はコードの読取だけ）。(2) 凍結した G-case の setup を実 Electron で作ること（setup-driver は dev fixture だけを扱う）。(3) G-case の Graph の arm がこれまで観測されていないことの全 run での確認。(4) 新しい addendum の file で `pnpm eval:fixtures` が変わらないこと。(5) 候補 §7 の :220「他Scene/seedへのpinは作らない」の起案時の意図。(6) `assertSeedPinsBeforeK64` を variant ごとの workspace に当てる形（今の関数は case ごとに 1 行）。(7) seed つきの begin の Raw-ready の遅い外れ値が G-case で起きる頻度。addendum の file と観測前の commit、R5 の照合の match は未実施で、足した pin を使う評価の run はその後に限る。
- flake の監視（落ちたら原因を切り分ける。製品の回帰と決めつけない）: master Full の `chat-stream-workspace-switch`（console.error `[EditorPane] sceneLoad.loadAnchors:authorshipSpans failed`。直前に `Related Scenes query failed`。DA-2b の差分では説明できず、ローカルの 6 回で再現しなかった。workspace の切替中の古い read の race と推定）、PR CI の shard 6/7 の `nir1-scene-scope-projection-acceptance`（lane の timeout、または `runsAll` 82 対 81）、runtime perf の `coldStartMs`、Windows の `stateFileReach.integration.test.ts`、`recovery_join_slot_survives_restore_reentry_and_shutdown_with_zero_counters`、`a2_change_rebuilds_the_next_generation_without_mixing`（負荷の下）。必要なら X1-4 の journey の安定化 lane を立てる。2026-10-25 追記: runtime perf の `coldStartMs`（4512 ms 対 上限 4000）、`harness accepts a file held-Freshness sequence independently of stdout`（100 ms の timeout）、product journeys の shard 2/7 の `chat-stream-folder-switch` の click timeout、master Full の `full-runtime` の `longTask 107ms`（§6）も flake として監視に加える。PR CI の flake は `gh run rerun --failed`、Full の flake は同じ候補で新規に dispatch する（§12.2）。
- 起動時の JS graph（`scripts/check-performance-budgets.mjs`）の raw の余裕は 31 byte（上限 4,250,700。#717 で 700 byte 上げた。冒頭の表の現在地）。起動時 graph へ足すなら、まず lazy 側に置く。足りなければ、必要量と小さな余白だけ上限を上げてよい（ユーザーの 2026-10-25 の指示。§12.1）。手順は integrator の運用で、独立した 1 commit にし、旧値と新値・必要 byte・根拠を commit 本文と DR に書き、最終報告で開示する。DA-2b では緩和を使っていない。#717（チャット入力の下書き保存）は、下書きを session／project の削除と一緒に消す処理が初期 graph の store に入るため、raw の上限を 4,250,000 から 4,250,700 へ最小限だけ上げた（理由と実測 raw 4,249,993 → 4,250,669、gzip 1,342,871 → 1,343,227 は `scripts/check-performance-budgets.mjs` の注記にある。独立した commit だったかは、この同期では確かめていない）。

## 12. 運用メモ（2026-10-25）

integrator の運用の記録で、契約の確認でも規則の変更でもない。規則の正本（[GDX-PRECHECK-001](../../policies/quality/iron-laws.md#GDX-PRECHECK-001)、AGENTS.md）の文面は変わっていない。エージェントは編集しない（改めるならユーザーが指示する）。引き継ぎの文書とローカルの memory が持ち越されない環境（クラウドのセッションを含む）が、この repo だけで再開できるように書く。

### 12.1. 判断と確認の方針

ユーザーの 2026-10-25 の指示（integrator の記録による。逐語に近い要約。原文は会話記録にある）:

- 「契約の確認はユーザー本人が入力した正確な文だけを有効にしなくていい。基本的に重要な変更がある場合のみユーザーに確認し、それ以外は確認せず自動で走って構わない」
- 「[precheck] で止めるのは重要な場合のみ」
- 「commit と PR 本文にエージェントの名義をつけても構わない。メールアドレスだけ注意」
- 「できるだけクラウドセッションで実行したい」
- 「lazy load でやるならそれでも良いが、gzip の容量制限のために機能を削るくらいなら上限緩和しても良い」

運用:

- ユーザーに確認し、`[precheck]` で止まるのは「重要な変更」だけ。それ以外は確認せず、計画、実装、独立レビュー、PR、hosted CI、merge、master の Full まで自動で進め、最終報告で開示する。
- 契約の確認に「ユーザー本人が入力した正確な文」は要求しない。重要な変更では、チャットで内容を示し、通常の返答での了承を得る。
- 「重要な変更」の暫定の定義（integrator の提案。ユーザーの確認は未了で、ユーザーが直してよい）: (1) 製品の公開・有効化（PUB-G／PUB-L、閉じた gate を開ける、activation UI・開示文言の承認）、(2) 新しい外部送信先・データの受け手、security 境界を弱める変更（NC-1／Y-1 の変更、認可の削除、新しい authority）、(3) 利用者データの保存範囲の拡大、確認済みの閾値・合格基準の緩和、(4) 取り返しのつかない外向きの操作（release／tag の公開、履歴の書換え、データ削除）。
- 確認台帳の規則も 2026-10-25 に緩和した（ユーザーの指示。§1 の U8）: 行は、1つの `draftRef` と1つの `contractId` を曖昧さなく特定する明示の承認（自由な文、またはちょうど1つの `draftRef#contractId` を draft の SHA-256 つきで示した問いへの承認の返答）で確認され、固定の文との一致は要らない。integrator は返答を逐語で記録し、過去の exact statement の記録は履歴として有効のまま。
- 限界: ユーザーが言っていない確認を「得た」と記録しない。repo の validator や文書が確認の記録を merge の条件にしている変更は、その記録を作れないので、そのときだけ一言ユーザーに確認する。

### 12.2. 守ること

- merge の条件は §6 のとおり（最新の master に rebase、hosted の Quick と PR CI が green、`gh pr merge --squash --match-head-commit <head>`）。merge の後は master で canonical Full を、直前に green だった Full の commit を `candidate_base`、新しい master を `candidate_head` として dispatch する。Full の flake は `gh run rerun --failed` でなく、同じ候補で新規に dispatch する（rerun では `full-aggregate` が attempt 名の part artifact を見つけられず落ちる）。PR CI と Quick の flake は、失敗した job だけの rerun でよい。docs だけの作業では Quick／Full を自分から始めない（merge するときだけ）。
- git: master へ直接 commit／push しない。作業 branch で commit し、変更 file を明示して stage する（`git add -A` を使わない）。1 commit 1 目的。AGENTS.md、`.agents/skills`、`policies/quality/iron-laws.md` は編集しない。`policies/narrative/**` は validator が要求する最小限だけ。`policies/architecture/**` の baseline は `--write-baseline` による縮小だけ。NC-1／Y-1（`electron/main/rendererContainment*`、`electron/scripts/webrtc-block-probe*`）は変えない（`windows.ts` や `index.ts` を変えるなら Y-1 の採り直しが要る）。Web Editor は廃止済みで考慮しない。
- commit と PR 本文のエージェントの名義（Co-Authored-By ほか）は付けてよい（任意）。必ず守るのはメールだけで、author と committer は `kazormia296@users.noreply.github.com`。個人のメールを履歴に入れない（この repo は切り直せない。updater の endpoint がこの repo の URL を指す）。push の前に `git log --format='%an <%ae> / %cn <%ce>' origin/master..HEAD` で確かめる。
- subagent: 実装と修正は Opus（Agent ツールで model と effort を明示。危険な lane は effort high）、in-loop のレビューも Opus、最終受入れだけ Fable（effort high。候補を編集しない独立の受入れ。in-loop レビューの合格を代わりにしない）。Workflow の `agent()` は model の指定が効かない環境がある（実際に使われた model は `workflowProgress` で確かめる）。Opus／Fable が要る段は Workflow の外の Agent ツールで行い、workflow の結果を「Opus レビュー」「Fable 受入れ」と PR 本文に書かない。agent の文脈は小さくし、機械的な確認は script で行う。
- CI の Rust は 1.99.0、ローカルの stable は 1.96.1。clippy の `-D warnings` は `cargo +1.99.0 clippy --manifest-path electron/native/grimodex-node/Cargo.toml --all-targets --features licensing,legacy-keyring-migration -- -D warnings` でも確かめる（`question_mark` の指摘で PR CI が落ちたことがある）。
- `Cargo.toml` や lock など、`scripts/local-ci-full-workload-allocation.json` が sizing digest を束縛する file を変えたら、その sha256 も更新する（Quick の `Reviewed Full workload data covers the real plan…` が落ちる）。
- Native の owner を変える PR は、同じ head に `ci.yml` の `canonical_profile=c-query-workers` と `c-query-lifecycle` も dispatch する（§6 の手順 3 のとおり）。
- 検証はリスクで選ぶ。同じ候補・環境・command の成功は、変更や失敗が無ければ再実行しない。未実行を成功扱いしない。完了時は結果、実施した検証、未解決事項を報告する。
- 実 Electron をローカルで動かすときは `scripts/local-ci-xvfb.mjs` を host の namespace で使い、`WAYLAND_DISPLAY`、`XDG_SESSION_TYPE`、`DBUS_SESSION_BUS_ADDRESS` を除く。Xvfb を `unshare -rn` の中で動かさない（利用者の X0 socket を消す）。Chromium は辞書の取得などで env の proxy では止まらない外部通信をする。
- worktree を消す前に `git status --porcelain --ignored` で ignore 対象（判断の記録、`.artifacts/`）を確かめ、必要なものを追跡される場所へ退避する。
- hosted の新しい workflow は、ローカルで偶然動いた前提（node_modules に展開済みの Electron など）を持ち込む。初回の hosted の run を 1 回分見込み、`ensure-electron-binary` のような既存 CI の手順を確かめる（2026-10-26。#728）。
- 変異試験の script が `git checkout` で戻すと、未 commit の修正を消す。変異は commit の後に、保存した原本の copy で回す（2026-10-26）。
- 大きな branch で master と同じ file に双方が追記した衝突は、rebase（commit ごとに衝突）より merge で 1 回解く。squash merge なので履歴の形は結果に影響しない（2026-10-26）。

### 12.3. クラウドのセッションで実行する場合

- 最初に確かめて、結果を 1 回だけ報告する: (1) `git config user.email` が `kazormia296@users.noreply.github.com`（違えば設定する）、(2) `gh auth status` の scope（`workflow` と PR の merge）と `claude/*` への push、(3) `nproc`、`free -h`、`df -h`、Rust／Node／pnpm、Xvfb、(4) Agent ツールで model（Opus／Fable）を明示できるか、(5) master の先頭と最後に green だった Full が冒頭の表の現在地と一致するか。できない操作（Full の dispatch、merge）は、ローカルのセッションかユーザーに頼む。
- 引き継げるもの: GitHub の repo（CLAUDE.md、AGENTS.md、commit 済みの `.claude/hooks`・skills・settings、`docs/plans/`）と、セッションに渡すプロンプト。引き継げないもの: ローカルの memory、scratchpad、ローカルの worktree（cargo の warm target、node_modules）、keyring の gh 認証、Xvfb と Electron の隔離環境、重い cargo の排他。
- 分担の目安: クラウドは、コード変更、対象を絞った vitest／tsc／eslint／cargo check、独立レビュー（read-only）、docs、hosted CI の監視と flake の切り分け、CP-2b の workflow 作業（3 OS は GitHub Actions の matrix）。ローカルは、実 Electron の journey の再演（Xvfb と network namespace を使う型）と、warm target での重い cargo。クラウドで重い cargo が動くなら使ってよいが、資源を先に確かめる。
- 待ちと再開: CI は GitHub 側で進むので、セッションが閉じても run は続く。再開時は `gh run list`／`gh run view` で拾う。状態は、この文書の冒頭の表の現在地、§6、PR 本文に残す。ローカルのセッションと並行するときは、同じ branch／PR を同時に触らない。クラウドの branch は `claude/…`。
