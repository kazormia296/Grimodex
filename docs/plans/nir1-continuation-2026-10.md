# NIR-1 続行計画の作業記録（2026-10）

更新日: 2026-10-13（初版: 2026-10-12）

| 項目 | 値 |
|---|---|
| 状態 | NIR-1 続行計画は 2026-10-12 にユーザーが承認済み。本書は G0 で作成した作業記録 |
| 計画 | `~/.claude/plans/610-pr-c-query-nir-valiant-thunder.md`（repo 外）。承認時（21:51 JST）の本文の SHA-256 は `0bfb2a90a0b1b0e13b39b99de825674647d88621afe30855d5bed2151efb474e` で、会話記録の承認本文と一致することを G0 で照合した。23:05 JST の改訂後は `f712102e78ca4e3dc217a6e6b1fc637e6a9085050d24e7b586fb6c179ee2e335`。改訂は、Ralph から Workflow subagent への切替（§1 の U3 変更）を記録する1行の追加だけで、その行を除いた本文の SHA-256 が承認時の値と一致することで照合した。2026-10-13 00:46 JST に、B-ROUTE の行と merge 列への B-ROUTE の挿入を足した。G0 の freeze の前には、B-ROUTE の扱い（C-product の前提、§3.1）の文言を直した。その時点の SHA-256 は `408a7a48d47e0f593b1a7c1e77620b8f11b77f40a7cfee3ec37a432645d03f8c`。承認後の改訂は integrator の運用上の記録で、ユーザーが承認したのは承認時の本文（`0bfb2a90…`）である |
| 基点 | `origin/master@a153743b3f672b7274bdd748f15ef9c216dc9961`（#629） |
| 位置づけ | ユーザー決定、委任判断、レーン、merge 列、worktree 台帳の記録。契約の批准、閾値の変更、製品公開の根拠にはしない |
| 正本 | 契約と確認台帳は [L6〜L9実行計画](nir1-l6-l9-execution-plan.md)、残工程の依存と受入れは [post-B実行計画](nir1-post-b-execution-plan.md)、委任の規則は [GDX-PRECHECK-001](../../policies/quality/iron-laws.md#GDX-PRECHECK-001) |

## 1. ユーザー決定（逐語）

決定日は 2026-10-12（JST）。integrator セッション（`3754f9a7-620d-4e21-ad37-3096691a96be`）の会話記録にあるユーザー自身の回答を、G0 で照合して逐語で転記した。選択肢を選んだ回答は、その選択肢の label を逐語とする。問いは要旨である。

| ID | 時刻（JST） | 問い（要旨） | ユーザーの回答（逐語） | 計画での扱い |
|---|---|---|---|---|
| U1 | 17:22 | 2026-09-25/26 に Codex で回答された off-master 承認を master の確認台帳へ記録し、承認済み draft を保全してよいか | 「使わずに計画し直す」 | 9/25-26 の承認と WIP は参照扱いにとどめる。契約は最新 master 前提で、新しい draftRef（K1〜K6）として起案し直す。移植するコードは新しい候補として再試験・再レビューし、旧 review 証跡は流用しない |
| U2 | 17:22 | 承認済み草案（同時 2 MiB・8 ms 前提など）と #610／#611 の実装が食い違った。どう扱うか | 「2MiB/8ms はキツすぎてCodexでは達成できませんでした。何かいい案があれば挑戦してもいいかもしれませんが、現状は達成不可能です。」 | 2 MiB／8 ms は達成不能として扱い、現行の C-query 契約（100 ms result lease、aggregate physical-memory cap/proof なし）を前提にする。8 ms への挑戦は任意 |
| U3 | 17:22 | 今後の `[precheck]` 停止をどう運用するか。選択肢1は、#610 型の技術委任を NIR-1 の残レーンへ広げる案 | 「1でRalphを使ってやるかどうかは任せます。」 | #610 型の技術委任を NIR-1 の残レーン全体へ広げる（§3）。Ralph を使うかは integrator に任された |
| U3 追加 | 18:45 | 問いへの回答ではない。最初の計画提示（ExitPlanMode）を差し戻したときのユーザーのメッセージ。計画の承認は、21:51 の2回目の提示に対するもの | 「Ralphの実行はPiではなくClaudeCodeにしてください」 | エンジンは Claude Code にし、Pi と OpenAI は使わない。Ralph は Claude Code の backend で動かす（§5。23:05 以後の実装は U3 変更に従う） |
| U4 | 17:22 | 各レーンの到達点 | 「merge まで進める」 | 独立受入れと hosted Full＋verify が green なら、merge 直前に base を照合して squash merge まで進める |
| U6 前段 | 17:28 | #610 で共有定数が 2 MiB から 6 MiB に変わり、A2 の Revision 保存上限と B の per-Revision 入力上限も変わった。どうするか | 「そもそもこんなにキチキチにメモリを制限している理由がよくわからん」 | 制限の経緯（応答時間、壊れたデータや巨大データへの防御、物理メモリ上限の証明）を説明し、資源契約の方針を改めて問うた |
| U6 | 17:31 | 説明を受けた後、今後の資源契約をどうするか | 「防御用の上限だけに簡素化（推奨）」 | 資源契約は防御用の上限だけに簡素化する。新しい資源契約として K1 で一度だけ確認を求める |
| U5 | 17:28 | CI 保守（ProduceSkia allowance 10-17、pnpm audit 例外 GHSA-ch52-4w7c-c8xp 10-18、Dependabot 10件）をどう進めるか | 「この計画では扱わない」 | CI 保守はこの計画では扱わない |
| U3 変更 | 23:05 | Ralph（Claude Code backend）の新しい起動が、auto mode の安全判定（Create Unsafe Agents。Ralph が子の Claude Code を `--dangerously-skip-permissions` で動かすため）で拒否された。今後どうするか | 「Workflow subagent で続ける（推奨）」 | 以後の実装は Ralph ではなく Workflow subagent で行う（builder → Fable による reviewer → fix の順。§5）。Ralph で起動済みの最初の3レーン（CR-1、DT-1、HP-1）の記述は記録として残す |

計画は 2026-10-12 21:51（JST）に承認された。U3 の「1」が指す選択肢の提示文は「#610 型の委任（worker/owner/終了処理/lifecycle の技術判断を作業記録に残して進める）を NIR-1 残レーンへ広げ、表記を 100 ms／aggregate cap なしへ更新する。新しい送信先・保存範囲・閾値緩和・製品公開・新しい契約は従来どおり確認する。AGENTS/iron-laws を更新する PR が必要。」である。表記の扱いは、承認済みの計画に従い、確認台帳の現行閾値と Gold への参照に置き換える。判断の記録先は §3.2 の形式に従う。提示文はユーザーの発言ではなく、選ばれた選択肢の範囲を示す記録として残す。

U3 変更で選ばれた選択肢の提示文は「Ralph の代わりに、このセッションの Workflow subagent（通常の権限、auto mode の安全判定あり）で実装する。進め方は builder→reviewer→fix で同じ。push、commit、gh を禁じる guard hook が無くなるが、subagent はこのセッションの権限判定の下で動くので、安全性はむしろ高い。」である。もう一方の選択肢（ユーザーが permission rule を追加して Ralph を再開する）は選ばれていない。計画ファイルには同じ 23:05 に、この変更を記録する1行（実行方式の「2026-10-12 の変更」）が追加された。この提示文もユーザーの発言ではなく、選ばれた選択肢の範囲を示す記録として残す。

## 2. 計画の要約

- NIR-1 の残工程を並列のレーンに分け、merge まで進める（U4）。製品入口（Graph、送信）は PUB-G／PUB-L まで閉じたままにする（A-1）。
- 9/25-26 の承認と WIP は使わず（U1）、契約は K1〜K6 として最新 master 前提で起案し直す。
- 2 MiB／8 ms は前提にしない（U2）。資源契約は防御用の上限に簡素化し、K1 で確認する（U6）。K1 は 2026-10-12 に確認された（§10.1）。
- 確認セッションは A（K1）、B（K2〜K6）、C（PUB-G、PUB-L）の3回とする。確認されなかった行のレーンだけを `[precheck]` で止め、ほかのレーンは止めない。
- CI 保守は扱わない（U5）。保守の失敗で Security job や Full が止まった場合は、merge 列を止めて実装を続け、ユーザーに報告する。

### 2.1. 契約（起案予定。9/25 の文面は流用しない）

| K | draftRef と contractId | 止めるもの | 状態 |
|---|---|---|---|
| K1 | `nir1-l6-l9-contract-proposal/6`：`graph-limited-binding`、`nir1-defensive-resource-limits` | CR-REC の HOLD 解除、Graph の根拠、HC-1、DT-5、CB-4、CP-1 の数値 | 確認済み（2026-10-12、Session A。2行とも。§10.1） |
| K2 | `nir1-c-body-disclosure-proposal/2`：`graph-target-scene-body-disclosure`、`scope-storage-authority` の差分 | CB-1〜4、CP-3 の Graph-only 追加、G-01、PUB-G | 起案前（Session B） |
| K3 | `nir1-d2a-activation-proposal/1`：`caller-profile-egress` の差分 | DA-1／2、CP-3a、PUB-G、DD-1 | 起案前（Session B） |
| K4 | `nir1-d2b-history-mapping-proposal/1`：`history-reauthorization` の差分 | DF+-a、HS-1、HC-1、DI-1b／c | 起案前（Session B） |
| K5 | `nir1-d2b-local-send-proposal/2`：`nir1-local-product-send` | DF+-b、DT-4／5、DD-1、PUB-L | 起案前（Session B） |
| K6 | `nir1-final-request-eval-proposal/1`：`nir1-final-request-packing-eval`（条件付きで `g01-eval-revision`、`graph-eval-procedure`） | DP-H、DD-1、PUB-L、条件付きで CP-4 | 起案前（Session B） |

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

## 4. レーン表

「実装」の列で、integrator とあるものは integrator が自分で書くか、Workflow の subagent を直接監督して実装する。Workflow subagent とあるものは builder → Fable による reviewer → fix の順で回し、その後に独立受入れを置く（§5）。Ralph とあるのは、Ralph の起動が拒否される前に Ralph（Claude Code backend）で起動した最初の3レーンの記録で、以後の作業は Workflow subagent で行う（§1 の U3 変更）。未指定のものは integrator が割り当てる。

| レーン | 内容 | 実装 | 開始条件と依存 |
|---|---|---|---|
| G0 | ガバナンスと doc-sync。本書、U3 と U4 の反映、現在地の同期、旧 draft の banner、quality-manifest と impact-map の分類 | integrator | 即時 |
| K1（Session A） | 資源契約 /6 の2文。2026-10-12 に確認され、G0 に同梱して台帳へ記録した（§10.1） | integrator（起案と adversarial review） | 即時 |
| SPIKE（S1〜S6） | 投資前の診断。merge しない | Workflow の subagent | 即時。計測は窓を分ける |
| CR-1／CR-REC | C-resource の閉鎖（opt-in lane の dispatch、ignored の実 worker 試験の配線、CQ-2、U6 の安全失敗、dataset の更新）と受入れ台帳 | CR-1 は Ralph で起動（以後は Workflow subagent）、CR-REC は integrator | 即時。CR-REC の HOLD 解除は K1 の後（K1 は 2026-10-12 に確認済み。解除には CR-1 の lane 証跡と独立受入れが要る） |
| CP-0 | G-02〜G-08 の fixture・Gold・期待値の事前固定と P arm の足場 | Workflow の subagent と、それとは別の期待値 reviewer | 即時。Graph の出力を観測する前に固定する |
| DT-1→DT-2→DT-3 | D-transport の基盤（barrier と seam、bounded な create／claim／finish、AttemptBinding v2）。製品入口は作らない | DT-1 は Ralph で起動（以後は Workflow subagent）、DT-2 と DT-3 は Workflow subagent | 即時（U3 委任） |
| HP-1 | history 読取の前段（内部・未接続） | Ralph で起動（以後は Workflow subagent） | 即時。merge は DT-3 の後 |
| DSN | owner/lifecycle matrix、seam の API、join と frame、遅い Graph、renderer の切り出し、Main grant | Workflow で起案 | 即時。使う PR に同梱する |
| K2〜K6 の起案 | Session B 用の契約 draft | Workflow で起案し adversarial review | 即時。K2 と K4 を先に出す |
| CP-1、CP-2a | worker 内の pin join と NQG2、製品 owner | Workflow subagent | CR-1 の merge 後 |
| B-ROUTE（2026-10-13 追加） | B の whole-project build／publish を製品の maintenance 経路に配線する。自動実行は PUB-G まで閉じる | Workflow subagent | C-product の前提として U3 の委任で進める（§3.1）。Session B で通知する。CP-4 の前に merge |
| LEDGER-1 | Session B で確認された draft の台帳取り込み | integrator | Session B の後 |
| CB-1〜4（MG-1 を含む） | C-body v1 | CB-1／3／4 は Workflow subagent、CB-2 の writer と MG-1 は integrator | K2、DT-3、CP-1 の後 |
| DA-1／2 | D2a の route 区分と activation | integrator | K3 の後 |
| DF+-a／b | D-final 追補 | Workflow subagent | K4（a）、K5（b）の後 |
| DT-4 | audit、route、consent | integrator | K5 の後 |
| DT-5a／b | transport | Workflow subagent | K5、DF+-b、DT-1〜3 の後 |
| HS-1、HC-1a／b | history の保存と再認可 | Workflow subagent | K4、DF+-a、HP-1 の後 |
| DP-H | 最終 request 評価 harness | Workflow subagent | K6 の後 |
| CP-3a／b | wire、IPC、seed の UX | Workflow subagent | CP-2a、CB-4、DA-1 の後 |
| DI-1c／a／b | D1 最終統合（3分割） | Workflow subagent | c は DF+、DT-1〜3、HS-1 の後。a は CP-1／2a の後。b は HC-1 の後 |
| CP-2b | worker の同梱と 3-OS packaged smoke | 未指定 | audit 例外が解消されていれば単独。解消されていなければ PUB-G に同梱し、Session C-1 でリスク判断を求める |
| CP-4 | G-01〜G-08、24件、P の計測と A3 consumer activation の証跡 | 未指定 | CP-3a／b の後。計測窓で行う |
| PUB-G | Graph の公開 | integrator | Session C-1 の承認後 |
| DD-1、PUB-L | local 送信の製品入口と公開 | DD-1 は未指定、PUB-L は integrator | Session C-2 の承認後に PUB-L |
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

G0 → CR-1 → CR-REC → CP-0 → DT-1 → DT-2 → DT-3 → HP-1 → CP-1 → CP-2a → LEDGER-1 → B-ROUTE → CB-1 → DA-1 → CB-2（＋MG-1）→ DF+-a/b → HS-1 → DT-4 → DP-H → CB-3 → CP-3a → DA-2 → CB-4 → CP-3b → DT-5a/b → HC-1a/b → DI-1c → DI-1a → DI-1b → CP-2b → CP-4 → PUB-G → DD-1 → PUB-L → E-1 → E-2

各 PR の手順（U4。CI の実態は #627 以降の hosted 実行に合わせる）:

1. rebase して freeze する。
2. 独立受入れで P2 以上を 0 にする。
3. 列の先頭で shell-local の `candidate_base` と `candidate_head` を一度だけ解決する。branch を push し、remote HEAD が `candidate_head` と一致することを確かめる。
4. Full の dispatch の前に、同じ列で実行中の canonical Full がないことを read-only で確かめる。Quick はローカル（`pnpm ci:local:quick` と直後の verify）か hosted（`canonical-ci.yml` の `profile=quick`）で行う。Full は `gh workflow run canonical-ci.yml --ref <branch> -f profile=full -f candidate_base=<candidate_base> -f candidate_head=<candidate_head>` で hosted に dispatch する。ローカルの Full は Full admission で拒否される。worker・frame・Native owner を変える PR では、同じ head に `ci.yml` の C-query opt-in lane と lifecycle lane も dispatch する。
5. PR の `ci.yml` checks、Quick、Full（7 part と `full-aggregate` の verify）を green にする。失敗した run は失敗 job だけでなく全 job を再実行する。
6. merge の直前に `git fetch origin master` を実行し、base が `candidate_base` と一致することを確かめる。
7. `gh pr merge --squash --match-head-commit <candidate_head>` で merge し、merge commit の `^1` を approved merge base と照合する。

base が変わったら Quick と Full をやり直す。台帳、policy、計画の受入れの意味を変える docs は、editorial の例外にあたらない。

U5（計画外）への依存: M0（CI 保守。期限と Dependabot への対応）の Full が走っている間は、NIR の Full を起動しない。M0 が入った時点で、進行中の Full receipt は取り直す。10-17／18 を過ぎても M0 が入らず Security job と Full が失敗する間は、merge 列を止めて実装を続け、ユーザーに報告する。

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

`origin/master` の基点はいずれも `a153743b3f672b7274bdd748f15ef9c216dc9961`（#629）。`claude-nir1-dt2` は 2026-10-12 23:17 JST に、`claude/nir1-dt1` の DT-1 commit `3688a0633537818e80a88e40f056604ffa496e8a` から作った。`claude-nir1-dt3` は 2026-10-12 23:34 JST に、同じ DT-1 commit `3688a0633537818e80a88e40f056604ffa496e8a` から作った。`claude-nir1-cp1` は 2026-10-13 00:11 JST に、`claude/nir1-cres` の CR-1b commit `0e041537e8c56c43be38afea490c26857bb488a7` から作った。`claude-nir1-broute` は 2026-10-13 00:47 JST に `origin/master` の `a153743b` から作った（SPIKE S1 で、製品に B の sealed binding を publish する経路が無いことが分かったため、B-ROUTE レーンを追加した）。作成時刻は各 branch の reflog（`git reflog show --date=iso <branch>`）の作成記録で確かめた。以後に作る worktree は、作成時に本表へ追記する。merge 済みのレーンの worktree は、この計画で作ったものに限って片付ける。

## 8. 2026-09-25/26 の off-master 承認と WIP（不採用・参照のみ）

- U1 により採用しない。master の確認台帳には記録せず、承認の根拠にも文面の流用元にもしない。
- 対象は Codex worktree に残る未 commit の draft と WIP で、基点は `689261c3`（#609）。worktree は `nir1-c-body-contract-draft`、`nir1-d-history-contract-draft`、`nir1-d-local-send-contract`、`nir1-d-startup-barrier-contract`、`nir1-goal-baseline` の5つ。
- 参照のため、tracked diff と untracked ファイルを integrator の scratchpad へ凍結コピーし、SHA-256 を記録した（`SHA256SUMS` 自体の SHA-256 は `f8c0d27560862530fee558bffc23bab91564850b475e4ce39d3a874e4a160d19`）。repo には取り込まない。
- WIP から移植するコードは新しい候補として扱い、最新 master 上で再試験・再レビューする。旧 review 証跡は流用しない。
- 旧 C-body・history の draft（master 上の `nir1-c-target-scene-body-authority-proposal-draft.md`、`nir1-c-scene-body-disclosure-delta-draft.md`、`nir1-d2b-history-authority-proposal-draft.md`）は superseded とし、後継は K2 と K4 とする。

## 9. 停止点

1. Session A（D+0〜1）: K1 の2文。2026-10-12 に確認された（§10.1）。
2. Session B（D+3〜5、準備できた行から）: K2〜K6 と各選択肢。委任判断の一覧も通知する。
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

## 11. 未解決事項

- `[policy]` `.agents/skills/bump-version/SKILL.md` の手順9（97行目）は、release commit の Full に、ローカルの `pnpm ci:local:full -- --base "$release_base" --head "$release_head"` を指示したままである。Full admission が標準の GitHub-hosted job 以外を拒否するとした更新後の [GDX-TRACE-001](../../policies/quality/iron-laws.md#GDX-TRACE-001) と食い違う。release flow は G0 の範囲外（U5 の CI 保守に近い）なので、G0 では skill を編集しない。次の release の前に、hosted の canonical Full への読み替えを別に扱う。
