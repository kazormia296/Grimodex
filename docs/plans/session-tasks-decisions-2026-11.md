# SessionTasks（Release B）の判断記録（2026-11）

- 作成：2026-11-26。基点：`origin/master` `1306198db`。追記：2026-11-28（§9）。
- 対象：[Agent Collaboration Roadmap](agent-collaboration-roadmap.md) の Release B（SessionTasks Minimal）と Decision Gate A、[Mastra 移行計画](mastra-migration-plan.md) の MP-6・MP-9 との接続。
- 前提の正本：[ADR 007](../adr/007-agent-collaboration-execution-boundary.md)、[ADR 008](../adr/008-agent-default-mode-and-write-approval.md)、[ADR 012](../adr/012-work-focus-chat-and-context-boundary.md)、[Agent Auto／Write-Safety Roadmap](agent-auto-write-safety-roadmap.md)、[MP-4 の判断記録](mastra-mp4-decisions.md) の DR-MP4-57、[MP-5 の判断記録](mastra-mp5-decisions.md) の DR-MP5-7・DR-MP5-11。
- DR-ST-3・DR-ST-6 は ADR 007 と ADR 012 の記述と、DR-ST-9 は ADR 012 の記述と衝突するので、同じ PR で両 ADR に 2026-11-26 の追補を足した（利用者の回答「追補を足す (推奨)」）。それ以外は ADR を変えない。ADR と衝突する場合は ADR（追補を含む）が優先する。

## 1. 経緯

2026-11-25 に利用者が「SessionTasks をやるかの判断」を依頼した。利用者が期待した働きは（原文の選択）「続きが分かる,目的と条件の固定,進み具合の表示,承認済みの連続実行」。実 API の比較（§2）と、Mastra の source との照合（§3）を経て、2026-11-26 に §4 の決定を得た。「目的と条件の固定」は、その後の回答で外した（DR-ST-9）。

## 2. 実 API の比較の結論（DR-ST-1）

条件：Haiku 5.5（文脈の窓 1M）、effort high、`max_tokens` 32,000、各方式 3 本の中央値。1 つの課題と 1 つの作品だけで、他のモデルには持ち越さない。harness と生データは作品の本文を含むので、リポジトリの外に置いた。

- 事前に登録した判定の規則は、どれも成立しなかった。「小さい修正（tool の記録の引き継ぎ）」と「手順と目的の一覧（SessionTasks 相当）」の差は、ばらつきの範囲だった。**SessionTasks を前倒しする根拠は出ていない。**
- 続行が起きた理由は、loop の tool 回数の上限（この model では 25 回、`limit_calls`）だった。`max_tokens` ではない。続行の回は tool の結果が落ち、読み直しが増えた（今のままの方式で再読込み率の中央値 0.83）。
- 前の回の tool の呼び出しと結果を次の回に残す方式は、規則の上では読み直しを減らしたが、検出の質が下がり、3 本中 2 本が thinking だけの打ち切りから抜けられなかった。
- 製品の値（`max_tokens` 4,096）のままでは、長い読み取りの依頼は 5 本とも thinking だけで上限に達し、completed で終わった。これは #1133 で直した。
- 測っていないもの：進み具合の表示（画面の価値）、承認した範囲の連続実行。

## 3. Mastra の source との照合（DR-ST-2）

対象：`@mastra/core` 1.83.0、`@mastra/memory` 1.41.2。入っている版の `node_modules` の dist を読んだ（web の文書は根拠にしていない）。読むだけで、実行はしていない。行番号は dist の chunk のもので、版を上げると変わる。

| 期待 | 結論 | 要点と出どころ |
| --- | --- | --- |
| 進み具合の表示 | Mastra では足りない | 組込みの task tool（`task_write`・`task_update`・`task_complete`・`task_check`。`state-processor-*.js` の 275・321・376・418 行付近）は、AI が一覧を全置換でき、自分で完了にでき、古い更新を拒む検査が無く、状態が 3 値。保存先（threadState）は既定で in-memory。 |
| 承認済みの連続実行 | 部品だけある | tool ごとの `requireApproval`（boolean か関数。`tools/types.d.ts` 671 行付近）、`beforeApproval`、approve／decline。範囲の定義、grant、耐久な承認の記録は Mastra に無い。 |
| 続きが分かる | 配送は足りる | 呼び出しごとの `system`／`context` は messageList に足され、保存されず、trim の外（`evented-execution-*.js` 52290 行付近）。保存先と現在位置の持ち方は製品が作る。 |

- Goals（`setObjective`）は Mastra の instance を要し（`evented-execution-*.js` 53401 行付近の `resolveGoalStore(this.#mastra)`）、judge の LLM が会話の本文を受け取る。AgentController の permission は tool 名の単位で、grant は同じプロセスの一時状態（`agent-controller-*.js` 5344 行付近）。製品は `new Mastra(` を静的試験で禁じている。
- ee（enterprise）の機能は、上のどれにも当たらない（調べた範囲）。
- 今の製品の要約は assistant の行だけを対象にする（`src/features/chat/conversationHistory.ts` の tier3 が `role === "assistant"`）。作者の発言は tier1（最初の 1 件と直近 3 往復）と tier2（L5 の予算の 40% の範囲で新しい順）に入る範囲で原文が残る。予算を超えた古い発言は外れうる。
- 「計画に無い」と最初に報告した項目のうち、承認した範囲の連続実行は ADR 008 §3〜5 と権限の層構造（`mutate / task-scope`、Task Grant、ApprovalRequest）に、手順と進み具合は Release B に、確認待ちの保存は ADR 007 §5 と Release A の A3 に、既にあった。無かったのは、それらと Mastra 移行計画とのつながりである。

## 4. 決定

### DR-ST-3 完了の方針

利用者の回答（構造化質問、2026-11-26）：「この書き方でよい (推奨)」。発言（原文）：「矛盾を一覧にまとめる、も完了できて良いと思います。本当に完了の承認が必要なのは書き換えとかだけだと思います。」

- 本文などの書き換え（ADR 008 の `effect: "mutate"` と `"destructive"`）を伴わない手順は、読む手順もまとめる手順も、AI が完了にできる。作者は後から戻せる。
- `mutate` を伴う手順は、ADR 008 の承認（承認済みの Task Grant の範囲、または個別の承認）を経て完了する。`destructive` は Task Grant があっても毎回個別の承認が要る（ADR 008 §3、不変条件 3）。
- `stage`（例：`propose_scene_body`）は、提案を作るまでが自動で、正規状態への適用は別の承認。提案を作っただけでは、適用を目的とする手順を完了にしない（ADR 007 §2 の Generated → Reviewed → Applied → Verified → Done）。
- ADR 007 §6 が明示の承認を要するとする変更（依頼の範囲の拡張、read-only から mutation への昇格、required acceptance condition の削除・緩和、Project Task への昇格、grant の範囲の超過）は、この方針でも承認が要る。
- Release B の出口条件「主観 Task は `review` へ進めるが、Agent の自己申告だけで `done` にならない」は削る。
- ADR 007 の「AgentRun の成功は WorkTask の完了を意味しない」と、製品の表示で applied・verified・complete・current を区別すること（不変条件 15）は変わらない。
- ADR 012 §1 の「manual／agent_proposes という割り切りを維持する」は、この方針に合わせて追補した。

### DR-ST-4 承認した範囲での連続実行

利用者の回答：「候補にして mock で確かめる (推奨)」。発言（原文）：「1,Mastraのやつ使ったほうが良いんじゃないでしょうか？測定も欲しいですね。」

- 範囲と承認の正本は ADR 008（`mutate / task-scope` は承認済みの Task Grant の範囲の中なら確認なしで実行、範囲の外は個別の承認、`destructive / always` は毎回確認）と ADR 007 §6。SessionTasks はこれを使い、別の承認の仕組みを作らない。
- 前提：ADR 008 の承認の境界（`effect`／`approvalMode`、main の承認の検証と Capability の発行の時点）は Write-Safety Roadmap の Gate A（A1・A2）で作る。Task Grant（承認した範囲の定義と保存）は同じ roadmap で Gate C、つまり Release B に置かれている。Mastra には無い（§3）。
- MP-6 で Mastra の承認（`requireApproval`／`beforeApproval`／approve・decline）を、「止めて、人が押したら再開する」部品として使う案を、**候補**として MP-6 の設計に載せる（2026-11-28 追記：この候補は採らないと決まった。§9）。条件：
  - `resumeData` と、モデル入力の `approved` を、回答・承認・認可の根拠にしない。
  - `mutate`・`destructive` の Capability は、承認が確定した後にだけ発行する。承認待ちの間に既発行の Capability を延命しない（ADR 008 §4）。Mastra の承認は ApprovalRequest（ADR 008 §5）の画面側の手段で、記録、再検証、一回限りの Capability への交換は main が持つ。one-shot、sender・project・入力 digest の束縛は維持する。Mastra の承認で置き換えると製品の認可の削除になり、委任の外。
  - 承認した時点の引数の digest を固定し、承認の後に引数が変わったら拒否する。
  - 承認は main の command（窓・turn・toolCallId に束ねる。MP-5 の回答の経路と同じ形）から返す。
  - suspend のための workflows store は in-memory に限り、再起動の後は保留を捨てる。snapshot に prompt の本文が入るので、永続化は保存の範囲の拡大になり、利用者の確認が要る。
- 採る前に mock（API の費用なし）で確かめる。MP-5 の判断記録（第 2 節の事実）は、`requireApproval` の承認の後も実行 context の `resumeData` はモデルの値が優先すること、組込みの `ask_user`・`submit_plan` が `resumeData` で人の操作なしに通ることを記録している。「最初の止まりはモデルの引数で解除できない」は、MP-5 の調査の記録（Codex の作業記録、リポジトリの外）にあるが、この PR では確かめていない。mock は Mastra の担当が MP-5 の調査の続きとして持ち、結果を MP-6 の判断記録の材料にする（2026-11-26 に合意）。
- 脅威モデルの W12（[脅威モデル](mastra-migration-threat-model.md) の第 4 節、#1157 で追加）は、範囲を「MP-5 の問い合わせ（UI 系 7 本）では Mastra 組込みの承認・suspend／resume・`resumeData` を使わない（MP-6 の write の承認は MP-6 で決める）」に限って書かれている。MP-5 の判断記録の第 6 節の下書きの文は範囲を限っていない。MP-6 で採る場合は、mock の結果を添えて、W12 と DR-MP5-7（とその静的試験・実行の試験）の改訂を利用者に確認する。

### DR-ST-5 agent loop の tool 回数の上限の撤廃

利用者の回答：「この形で撤廃 (推奨)」。発言（原文）：「正直モダンなAIAgentで回数制限で止まってるやつ見たこと無いんですよね。ツールコール回数制限は撤廃で良いんじゃないでしょうか？」

- 今の上限（事実）：legacy の親の turn は `getAgentToolCallBudgetForContext(effectiveContextWindow)`（`src/application/chat/chatTurnStoreActions.ts` の呼び出し。定義は `src/features/chat/agent/modelLimits.ts`）で、文脈の窓が 400k 以上で 25、200k 以上で 16、64k 以上で 12、それ未満で 10。呼び手が渡さないときの既定は 10（`agentLoop.ts`）。Mastra の経路は `electron/main/mastra/agentLoopRules.ts` の既定が 10 で、値は wire で届き、`electron/shared/mastraAgentTurnWire.ts` が 25 を超える `maxToolCalls` を拒む。Mastra の `maxSteps` は `maxToolCalls` と質問の回数から導く（`agentLoopRules.ts`、`agentRuntime.ts`）。wire には「上限なし」を表す値が無い。
- 対象は親の turn の `maxToolCalls`。撤廃は wire の契約の変更（上の検証の上限）を含む。`run_research` などの子の予算（`chatAgentToolHandlers.ts` で別に渡す）と、UI 操作と質問の回数の上限は対象外（利用者の決定）。UI 操作の上限は、本文に仕込まれた指示による操作の連打の抑止を目的にしている（`uiOperationTools.ts` の注釈）。
- 残る歯止め：tool の結果の累計の token の予算（`limit_tokens`。文脈の窓の 30%、最低 2,000。legacy と Mastra の規則の両方にある）は残る。回数の上限を外すと、長い読み取りの turn はこの予算で止まる。
- 撤廃の条件：
  1. 停止が効く経路から外す。legacy の経路は #1139 で停止できる。Mastra の経路は送信中の停止が未接続で、つながるのは 4c-2 の後。
  2. `limit_tokens` で止まったとき、または文脈が埋まったときに、成果を消さない扱いを決める（ここまでの結果を出して終える、要約して続ける、など）。扱いは設計のときに利用者に伺う。
- 根拠：`max_tokens` は 1 回の応答ごとの上限で、tool を呼ぶたびに新しい応答になるため、loop を止めない。実験では上限による続行が tool の結果を落とし、読み直しを増やしていた（DR-ST-1）。
- ADR 007 §6 の「budget の grant 範囲の超過」は Run に与える grant の話で、loop の回数の上限（コードの注釈では「データ取得予算」と呼ぶ）とは別のもの。Run 単位の費用や時間の grant を新しく置くかは未決。

### DR-ST-6 Decision Gate A

利用者の回答：「Gate だけ飛ばす (推奨)」。以前の発言（2026-11-25、原文）：「投機的実装でどうですか？」

- Release B は、Decision Gate A（Release A を約 10 件使った記録）を待たない。Gate A の問いは、Release B を作った後の振り返りの観点として残す。
- 確認待ちを会話の外に保存すること（Release B の product promise の一部）は、Release A の A3（durable AgentRun と durable interaction）と、その前提の R1・F0-lite を先に作って使う。Release A のうち A4a 以降（Background Session、UI、hardening）は待たない。Roadmap の principle 2（Task の進捗の表示より前に Background execution を成立させる）の例外として扱う。
- Release B の前提：Write-Safety Roadmap の Gate A（A1・A2）、Release A の A3（と R1・F0-lite）、Mastra 移行の MP-6（write tool と capability）と MP-9（履歴の持ち主と保存の移動）。担当と範囲は DR-ST-10。（2026-11-28 追記：「F0-lite」は F0-lite-A と読む。§9）
- ADR 007 と ADR 012 の Consequences（実運用で問題が観測された後に評価、既存の Decision Gate を維持）は、この決定に合わせて追補した。

### DR-ST-10 前提の範囲と担当（2026-11-27）

利用者の回答（統合者の構造化質問、2026-11-27。記録は `claude/nir1-contracts` の commit `e5d93dca8` の問 8〜10）：

- 問 8「SessionTasks の試験」は「Release B の機能まるごと」（書き換えの承認、連続実行、再起動をまたぐ確認待ち、続行の引き継ぎまで）。DR-ST-6 の前提 4 つ（Write-Safety の Gate A、Release A の A3、MP-6、MP-9）は全部要る。
- 問 9 Write-Safety の Gate A（A1・A2）は Release B の前提として確定した（「前提にする、担当は Mastra (Recommended)」）。担当は Mastra 移行の lane で、MP-6 の後に続けて持つ。authority の変更なので、設計ができたら利用者に伺う。
- 問 10 Release A の A3（R1・F0-lite を含む）は「新しい lane で実装まで」。保存の範囲の拡大と DR-MP5-11 の変更は、その lane が起案の段で利用者に伺う（委任の外）。

### DR-ST-9 作者が書く目的と条件の欄は作らない

利用者の回答（2026-11-26）：Mastra の担当への回答「要らないと思います。どこから生えてきた判断ですか？」、この判断の担当への回答「全部外す」。

- SessionTasks から、作者が書く会話ごとの「目的と条件」の欄と、要約から独立して注入する Task Contract を外す。残るのは、AI が書く手順と進み具合。
- MP-9 の「圧縮しても消えない目的欄」（DR-MP4-57 の 3）は取り下げる。移行計画の MP-9 の行には、この PR で取り下げの注記を付けた。MP-4 の判断記録の DR-MP4-57 の 3 の取り下げは、Mastra の担当の docs PR で記録する。
- Release B の出口条件「model switch または会話要約の後も同じ objective／required criterion を参照する」は削る。
- 作成者の補足（利用者の理由ではない）：今の製品の要約は assistant の行だけを対象にし、作者の発言は要約しない。ただし予算を超えた古い作者の発言は履歴から外れうる（§3）。この残余は承知の上で外す。
- ADR 012 §1 の「SessionTask は会話の圧縮、モデル変更、retry によって目的・制約・未完了事項が失われないための基盤」は、未完了事項（手順と進み具合）に絞るよう追補した。
- ADR 007 §6 の承認の対象（required acceptance condition の削除・緩和を含む）と不変条件 12 は変えない。手順ごとに required criterion を持つ場合にだけ当てはまる。

### DR-ST-7 Release B の要件と Mastra 移行計画の振り分け

利用者の発言（原文）：「あとの入ってないやつもMastraに任すかは任意ですが全部入れてください。」振り分けは Mastra の担当の見立て（2026-11-26）に従った。

| 要件 | 正本 | Mastra 移行計画の段 |
| --- | --- | --- |
| 承認の境界（`effect`／`approvalMode`、承認の後の Capability の発行） | ADR 008 §3〜5、Write-Safety Roadmap の Gate A（A1・A2） | MP-6 の capability の維持と合わせる |
| 承認した範囲での連続実行（Task Grant の定義と保存）と、その測定 | ADR 008 §3・権限の層構造・不変条件 2〜3、Write-Safety Roadmap の Gate C（Task Grant は Release B。ADR 008 §8 の Run Tool Grant とは別） | MP-6 に候補（DR-ST-4）、測定は §5 |
| 親の turn の tool 回数の上限の撤廃 | DR-ST-5 | Mastra の経路は 4c-2（送信中の停止）の後。loop の規則と wire の検証の上限を変える |
| 手順と進み具合の保存・AI が書く tool・画面 | Release B | 依存だけ |
| 確認待ちを会話の外に保存 | ADR 007 §5、Release A の A3 | 依存だけ：DR-MP5-11 と W12 の「再起動の後に復元しない」を変える継ぎ目。保存の範囲の拡大なので、変えるときに利用者の確認が要る。2026-11-28 追記：確認は済んだ（§9） |
| 古い Task の更新を拒む（OCC） | ADR 007 §2・§4（WorkTask は独立した authority で、OCC version を Native が持つ SQLite に置く） | 依存だけ。Task は Native の独立した表に置き、Mastra の thread metadata には置かない |
| Task を手で片付けなくて済む | Release B の出口条件 | Release B |
| 続行のときに読んだ内容を引き継ぐ | Release B | MP-9（履歴の持ち主）。続行を出す条件は wire（P14 の Q4）と renderer。DR-ST-1 で質が下がった形をそのまま採らない |
| Decision Gate A の扱い | roadmap | DR-ST-6 |

Mastra 組込みの task／plan の tool、Goals、AgentController は使わない（§3）。

## 5. 測定（DR-ST-8）

- **仕組みの確認（今できる。API の費用なし）**：DR-ST-4 の mock。Mastra の担当が持つ。
- **実 API の測定（MP-6 の後）**：旗 L を開けた製品の経路（journey の seam）で測る。手作りの仕組みは比べない。
  - 承認した範囲：範囲の外の書き換えが止まる率、範囲の中で止まらずに進む率、承認待ちで止まった回数、`resumeData` の偽装の成否、承認が混ざったときの並列度の低下。
  - 回数の上限を外した後：1 turn の tool 回数、`limit_tokens` や文脈が埋まった回の扱い、費用。
- 実 API の測定の前提：測定用の userData に API キーを置く手順（秘密の置き場所が増えるので利用者に確認する）、送信先は Anthropic の API だけ、費用の上限は利用者が決める。

## 6. 画面の試作

「進み具合の表示」は API では測れないので、画面の試作（Design canvas、架空のデータ）を作って利用者に見せた（2026-11-26）。試作で表したこと：

- チャットの中に、承認した範囲、作業の進み（6 状態）、実行の記録（作業の進みとは別）。
- 読む手順とまとめる手順は AI が完了にする。止まって作者を待つのは、本文の書き換えと、依頼の範囲を広げる提案。tool の回数の区切りでは止まらない。
- 会話の一覧に、作業のある会話の状態（承認待ち・止まっている・完了）を出す。

## 7. 信頼境界と脅威モデル

- この文書は要件と順序の記録で、製品の挙動、wire、保存、送信先を変えない。脅威モデルの確定文書も変えない。
- 新しい送信先は無い。実 API の測定は Anthropic の API だけに送る。
- 確認待ちの保存（DR-ST-6・DR-ST-7）と、suspend の snapshot の永続化（DR-ST-4）は保存の範囲の拡大にあたり、実装の前に利用者の確認が要る。確認待ちの保存は、A3 の lane が起案の段で DR-MP5-11 の変更と合わせて伺う（DR-ST-10）。（2026-11-28 追記：確認待ちの保存は確認済み。§9）
- Write-Safety の Gate A（A1・A2）は承認と Capability の発行の authority を変える。Mastra の lane が設計を終えた段で利用者に伺う（DR-ST-10）。（2026-11-28 追記：確認済み。§9）
- 回数の上限の撤廃（DR-ST-5）は製品の挙動と wire の契約の変更で、撤廃の PR で条件を満たしてから行う。

## 8. 未確認

- DR-ST-4 の mock は Mastra の担当が 2026-11-26 に回した（作業記録はリポジトリの外）。報告の要点：モデルの `approved`・`resumeData` では承認は解けない。承認の後も `resumeData` と引数はモデルの値なので、引数の digest の固定と実行の直前の照合が要る。承認待ちは同じ turn の読み取りも止める。abort しても run は suspended のままで、保留は main の側で閉じる。MP-6 で採るかと W12・DR-MP5-7 の改訂は、MP-6 の設計で利用者に伺う。（2026-11-28 追記：採らないと決まった。§9）
- Task の保存先（Native の独立した表。schema の版上げ）。
- `limit_tokens` で止まったとき・文脈が埋まったときの扱い（DR-ST-5 の条件 2）の方式。
- 結果の小さい tool を繰り返し呼ぶ turn は `limit_tokens` に届きにくい。回数の上限を外した後に、これを止める手段を置くか。
- wire で「上限なし」をどう表すか。
- Run 単位の費用や時間の grant を新しく置くか。
- Write-Safety Roadmap の Gate A は 2026-11-27 の時点で Planned（統合者の確認）。担当と順序は DR-ST-10。（2026-11-28 追記：§9）
- 実 API の測定の API キーの置き場所と、費用の上限。
- Release B を作った後の振り返り（Gate A の問い）の時期と方法。

## 9. 追記（2026-11-28）：前提の側で決まったこと

2026-11-27 に、Release A の A3 と Write-Safety の Gate A の判断記録が、利用者の回答を得て master に入った。正本は [A3 の判断記録](a3-durable-agentrun-decisions.md)（#1198）と [Gate A の判断記録](gate-a-write-safety-decisions.md)（#1201・#1203・#1206）で、この節と食い違うときはそちらを優先する。上の節の当時の記述は残し、変わった点だけを書く。`origin/master` `b0ec3cd18` の時点で、Gate A（A1・A2）と A3 の実装は master に入っていない。

- **承認の仕組み（DR-ST-4）**：利用者は Gate A の問 3 で「作者の出来事の承認（AWA/1）と同じ仕組み」を選んだ。Mastra の組込みの承認を MP-6 の候補にする案は採らず、そのための W12 の改訂も要らない。main は、承認の要求を作る時点で入力の digest と base version を固定し、承認の後に確かめ直してから一回限りの Capability に交換する（DR-GA-3）。Task Grant が入るまで、`mutate`／`task-scope` は毎回個別の承認になる（同 第 1 節）。
- **確認待ちの保存（DR-ST-6・DR-ST-7）**：保存の範囲の拡大と、再起動の後の扱いの変更は、A3 の lane が利用者の確認を得た（A3 の判断記録 第 7 節）。
  - 中断した Run は、作者が「続ける」を押すか確認待ちの質問に答えたときに、保存した途中の状態から同じ Run として再開する。起動時に自動では続けない。再開には門と、今の状態に照らした結果の選り分けがあり、再開できない Run もある（DR-A3-6）。
  - 承認待ちも記録し、再起動の後は承認のカードを出し直す。保存した承認は認可に使わない（DR-A3-14）。
  - 脅威モデルの W12 と DR-MP5-11 の「再起動の後に復元しない」の改訂は Mastra の担当の PR で行う予定で、上の時点の master では改訂前。
  - Mastra の workflows store を永続化しないことは変わらない。A3 が保存するのは、製品が持つ別の途中の状態（DR-A3-4）。
- **F0-lite（DR-ST-6）**：Release B の前提の「F0-lite」は F0-lite-A（A3 の lane）と読む。F0-lite-B（`WorkTaskStatus`、minimal `TaskContractSnapshotV1`、`AnalysisReadBasisV1`）は Release B の lane が持つ（DR-A3-13）。
- **未確認に加える**：
  - DR-ST-9 で作者が書く目的と条件の欄を外したので、`TaskContractSnapshotV1` の中身は定め直す必要がある（DR-A3-13）。
  - Gate A の判断記録は、旗 L を A2 の完了の前に開けないとする（第 2 節）。旗 L の経路で測る第 5 節の実 API の測定が A2 の後になるかは、測定を設計するときに Mastra の担当と確かめる。
