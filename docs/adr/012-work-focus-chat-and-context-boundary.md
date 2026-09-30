# ADR 012: Work Focus・共通Chat・Work Layer UIとコンテキスト取得境界

## Status

Accepted — 2026-09-15（製品・アーキテクチャ方針。実装・公開の承認ではない）

本ADRは、SessionTask／プロジェクト側WorkTask、Work Focus、会話の帰属、
Work Layerの表示、およびWorkScoped Chatのコンテキスト取得を整理する。
会話で検討した途中案ではなく、最後に合意した方針を記録する。

本PRは文書と参照資料だけを対象とする。DB migration、IPC、プロンプト、tool manifest、
Run Grant、runtime、consumer、feature flagは変更・有効化しない。
新たなsecurity-sensitive threat modelを確定するものでもない。
後続実装でその追加・変更が必要な場合は、draftと明示確認を含む既存の規律に従う。

## Authority / related decisions

- [ADR 003](003-db-authority-and-schema-contract.md) はCanonical SQLiteを所有する。
- [ADR 004](004-narrative-reconciliation-boundary.md) と
  [ADR 005](005-narrative-semantic-core-boundary.md) は解釈・根拠・Freshnessの境界を所有する。
- [ADR 006](006-narrative-mutation-authority-routes.md) は変更権限とwriter routeを所有する。
- [ADR 007](007-agent-collaboration-execution-boundary.md) はTask／Run／Interaction、
  継続性、承認、一貫性、完了判定を所有する。
- [ADR 008](008-agent-default-mode-and-write-approval.md) はAgent Auto、実効経路、
  読み取り・ステージングと書き込み承認の分離を所有する。
- [ADR 009](009-narrative-scope-relation-contract.md)、
  [ADR 010](010-narrative-dependency-role-granularity-contract.md)、
  [ADR 011](011-narrative-ir-revision-semantics-contract.md) はNarrative Scope、
  開示、依存、Revisionの契約を所有する。本ADRのChat Scopeはそれらを置き換えない。
- [Agent Collaboration Roadmap](../plans/agent-collaboration-roadmap.md) は実装順序と投資Gate、
  [Agent Auto / Write-Safety Roadmap](../plans/agent-auto-write-safety-roadmap.md) は安全なAutoの
  導入順序、[Narrative Semantic Core Roadmap](../plans/narrative-semantic-core-roadmap.md) は
  NIRの実装・公開判定を引き続き所有する。

本ADRは上記を補足し、既存Gateの完了やRelease順の前倒しを意味しない。
画像やプロトタイプの文言が既存契約と異なる場合、画像を契約として採用しない。

## Context

SceneScoped Chatでは、会話の対象と最初に読む資料をSceneから概ね決められる。
WorkScoped Chatでは「何をしたいか」は分かっても、「何を読む必要があるか」は
目的・今回の問い・調査結果によって変化する。

Workについて話しながら根拠のSceneを開いた結果、会話が別Sceneへ切り替わるのは不自然である。
一方、この問題をWork専用の常駐チャットや新しいドロワーで解決しようとすると、既存の
ヘッダーTask Tray／All Workが持つ目的・Task・Attentionを重複表示することになる。

問題の中心は常駐領域の不足ではなく、次の混同にある。

- 作者が今取り組むWorkと、今見ている資料。
- 会話の帰属先と、エディタ選択への表示追随。
- 参照可能な資料、実際に注入した資料、追加探索で読んだ資料。
- UIが表示中であること、Runが継続すること、変更を許可すること。

Work Layerは、創作をTODO消化へ置換するためではなく、途中の意図・判断・未完了事項を
失わずに執筆へ戻れるようにするために置く。

## Terminology

| 用語 | 本ADRでの意味 |
| --- | --- |
| SessionTask | 一回の依頼やSession内の計画を進める段取り。通常ChatにもWorkScoped Chatにも存在できる。 |
| Work / プロジェクト側WorkTask | 会話を離れても保持する作者の目的・作業。本ADRで新たな第三のドメイン型を追加するという意味ではない。 |
| WorkPlan | 関連Taskをまとめる計画。既存Task契約との具体的な型対応は後続設計で決める。 |
| Work Focus | 作者が「今の仕事」として選んでいる対象。最大一つ、未選択も正常。 |
| Conversation subject / Chat Scope | ある会話が何に帰属するか。Scene、Folder、Work等の具体的な対象。 |
| View attachment | どのSessionを、どのChat表示で見ているか。 |
| Injection | 今回モデルへ渡す、予算・開示制約を通過した具体的な材料。 |
| Additional retrieval | Agentが今回の依頼に必要な材料を追加で検索・取得すること。 |

Chat Scopeは会話の帰属であり、Narrative Scopeや送信・書き込み権限そのものではない。
WorkのUI名称だけを理由に既存WorkTask／WorkPlanを複製しない。

## Decision

### 1. Taskは目的・意図を保持し、作品の正しさを強制しない

SessionTaskは、会話の圧縮、モデル変更、retryによって目的・制約・未完了事項が
失われないための基盤である。Taskを細分化すること自体やTask件数を価値指標にしない。
初期のplain-text criterion、manual／agent_proposes、Evidence linkという割り切りを維持する。

プロジェクト側Workは、「何を変えたいか」「何を検討中か」「なぜ変えないと決めたか」を
作品や根拠と結び付けて保持する。AIを使わない作者の手作業も扱える。

Finding／Attentionは観測・判断候補であって、作者が引き受けたWorkTaskではない。
SessionTaskの存在、AIの指摘、会話での言及だけでProject Taskへ昇格させない。
昇格やscope拡張はADR 007の承認／grant境界に従う。

生成、レビュー、適用、検証、完了を混同しない。AgentRunの成功だけでWorkをdoneにしない。
完了済み創作Taskは後発Findingだけで黙って再openしない。保留、取りやめ、意図的なものとしての
判断も保持し、未達条件を満たしたと偽装せず、作者が選択できるようにする。

### 2. Work Focus、Work状態、会話の対象、実行状態を分離する

Focusは作者のプロジェクト別作業設定であり、概念上の`focusedWorkId`に相当する単一参照である。
各Workの独立した`focused`フラグ群や、`in_progress`状態の別名として扱わない。
永続化・競合処理の具体的なschemaは本ADRでは固定しない。

| 操作 | Focus | Work / Run |
| --- | --- | --- |
| Workや関連会話を開く | 変更しない | 閲覧だけでは状態変更・実行開始しない。 |
| 「今の仕事にする」 | 明示的に対象へ切り替える | 他のWorkをwaitingへ戻さず、Runを停止しない。 |
| Chat切り替え、Scene移動、Resolve出入り、UIを閉じる | 維持する | 表示操作をcancelや完了扱いにしない。 |
| Focus解除 | 未選択にする | Work・途中Task・会話は残す。 |
| 作者による完了／アーカイブ | 対象を解除できる | 次のWorkを自動選択しない。 |
| プロジェクトへの復帰／再起動 | 保存済み選択を復元できる | 選択復元をRunの自動開始／resumeとしない。 |

FocusはレイアウトプリセットやChatコンポーネントの寿命に従属させない。
ヘッダーとトレイはFocusへの帰路を提供するが、Focusは全編集・全会話を暗黙に所有しない。
別Workの通知やAIの質問待ちも、Focusや表示Sessionを勝手に奪わない。
対象が削除・利用不能になった場合は明示的な未選択／利用不能として扱い、別のIDへ代替しない。

### 3. 通常ChatとWorkScoped Chatは共通のChatパネルで表示する

Work管理はTask Tray／All Workに残し、「この仕事について相談する」から共通Chatを開く。
Work専用の常駐チャット、Work詳細コンパクト画面、追加サイドドロワー、
right stripe全体の通常／Work切り替えモードを、この要求のためには新設しない。

共通化するのは表示・Session／Run基盤であって、会話履歴の一本化ではない。
Scene／Folder等の会話とWorkの会話は、それぞれ独立したSessionとして保持する。
対象変更は該当Sessionへの明示的な切り替え／作成であり、既存履歴の帰属を付け替えない。

Work会話は`current focused work`という可変の参照ではなく、具体的なProject・Work対象に結び付く。
Focusを別Workへ変えても、開いているSessionの目的・保存先・Injection対象は変わらない。
Chatヘッダーに会話の対象を明示し、必要なTaskへの参照とトレイへの帰路を提供する。
Work管理画面をChat内へ重複実装しない。

一つのWorkと一つのSessionを強制的に一対一対応させない。会話なしのWorkも、
同じ仕事に複数の相談Sessionがある場合も扱える。正確なWorkPlanとの紐付けは後続schema設計に委ねる。

### 4. 会話の帰属とエディタ追随を分離する

Scene追随表示では、エディタ移動に応じて対応するScene Sessionを表示できる。
これは表示先の変更であり、旧Sessionの帰属や進行中Runを変更する操作ではない。
Folder等の既存の対象固定ルールを、このScene追随のために一律変更しない。

Work Session表示中は、Scene、Folder、Codexを開いても会話を維持する。
エディタに表示された資料は、閲覧しただけで今回の送信材料にならない。
「この場面」「ここ」などで対象が特定できなければ、明示参照を求めるか対象を確認する。

Session、下書き、閲覧位置、pending interactionは、表示切り替えで失わない。
Run開始後のProject／Session／依頼対象はcapture済みの対象へ固定し、結果を正しいSessionへ保存する。

### 5. 通常Chat、Task、Work、Work会話の双方向参照を提供する

同じ対象への参照を双方からたどれるようにし、履歴の丸ごとコピーで双方向性を実現しない。
参照はProject、対象種別、安定IDを識別し、必要に応じてSession／message／Task／Revisionを指す。
リンク元が対象の存在しない別Projectへ誤って解決されてはならない。

次の操作は区別する。

| 操作 | 効果 |
| --- | --- |
| 参照をプレビュー | 該当Taskや発言、引用をその場で読む。Focus・帰属・送信材料を自動変更しない。 |
| 参照先を開く | 共通Chat等で正しい対象へ移動し、元の文脈へ戻れるようにする。 |
| 今回の入力に含める | 開示・予算・版を確認した具体的な材料を、明示的にコンテキストへ追加する。 |

Workに資料リンクがあることは全文注入の許可ではなく、参照先の履歴を再帰的に全取得する指示でもない。
削除済み、版不一致、開示不可の対象は利用不能として表示し、似た対象へ推測で差し替えない。
原発言・引用の出所と、そこから作られた要約／判断を区別する。

通常ChatでTaskへ言及しただけなら参照を付ければよい。SessionTaskが生成されてもWorkへ強制移動しない。
継続仕事へ昇格する明示操作では、目的・制約・必要な材料と元の発言への参照を引き継ぎ、
元の相談を残す。Work作成／昇格と、画面の遷移は別の効果として扱う。

### 6. Resolve Lensは一時的なright stripe専用パネルへ変更する

参照プロトタイプの右上モーダレス重ね表示は採用しない。
Resolve中だけ、right stripe最上段グループに、Editorと同様に単体では閉じられない
専用Resolveパネルを追加する。カードレイアウトでも角丸なしとする。

Resolveを表す強調枠は、このパネルと対応するStripeアイコンに適用し、画面全体を囲む
Resolve外周フレームは採用しない。本文の根拠箇所のマーキングは維持できる。
本文や通常Chatを覆わず、既存領域を使って判断対象・根拠・候補・採否を提示する。

パネル単体の閉じる操作を無効にしても、Resolve自体から離れる操作は必ず提供する。
判断せず離れただけでresolve／hold／dismissを記録しない。終了時は一時パネルを除去し、
無関係なパネルを失わず通常の配置へ復帰する。内部の候補選択などの途中状態は、
後続実装で明示的に定めた寿命に従い、保存済み判断と区別する。

ヘッダーの短時間のポップオーバーは維持する。「重ね表示を採用しない」は、
常駐的なWork詳細やResolve Lensのモーダレス重ね表示についての決定であり、
トレイや一時的なDeep Inspectionまで一律廃止するものではない。

Projection／Review／Batchの全面表示は、比較・判断へ集中するための一時的な作業ビューとして
維持できる。Deep Inspectionの大型モーダルとは区別し、Work会話を使う必須経路にしない。
必要なら同じSessionを全面表示でも投影できるが、第二の会話正本を作らない。

### 7. WorkScoped Chatは「固定材料＋目的に応じた追加探索」で構成する

Scene Scopeは資料中心、Work Scopeは目的中心である。対象IDだけをSceneからWorkへ
差し替えて同じ自動注入を行う実装にはしない。

| 層 | 材料 | 選択規則 |
| --- | --- | --- |
| Work基本情報 | 目的、制約、受け入れ条件、今回のTask、作者の決定事項 | Workの正本から今回の依頼に必要な部分を構成する。 |
| 明示材料 | 指定Scene本文、Codex、成果物、引用した発言 | 作者の指定、今回の依頼、予算・開示判定に基づき、本文または参照情報を渡す。 |
| 追加探索 | 関連描写、前後章、根拠、反証候補、過去の判断 | Workの目的・今回の問い・指定対象を起点に、Agentが許可範囲で取得する。 |

既存のSession会話コンテキストを用いつつ、Task Contractを会話要約だけに依存させない。
Workに付いた全Task・全資料・全履歴を無条件に常時注入することは要求しない。
ただし必須制約を黙って切り捨てない。予算に収まらない場合は不足を示し、依頼の分割や確認へ進む。

Work基本情報も一貫性のある版を捕捉し、進行中の作者変更で目的や受け入れ条件を
黙って入れ替えない。Work情報と資料のfreshness／変更は区別し、必要な再確認へつなげる。
Sourceの読み取り一貫性はADR 007のcapture-on-first-read等に従い、
Project全体の同時点snapshotを暗黙に主張しない。

NIRは候補選択や根拠をたどる経路として利用できるが、既存の公開・適格性・開示契約を満たす
consumerだけを使う。文体・台詞・冗長さの検討など、本文自体が必要な依頼をNIR要約だけで代替しない。
Raw Textも残し、NIRを全資料の唯一の検索経路にはしない。

追加取得できることは、依頼が明確であることや、調査が網羅的であることを保証しない。
意図の不足は作者へ確認する。検索ヒットがないことを「矛盾なし」「全編確認済み」へ読み替えない。
参照した資料、未確認範囲、取得失敗、予算・回数による打ち切りを判別できるようにする。

### 8. WorkScoped Chatの基本体験は安全なAgent Auto。OFFを尊重する

Workについて作品横断で調べながら進める体験は、ADR 008の安全なAgent Autoを基本とする。
新たなWork専用Agent権限系は作らず、読み取り・ステージングと正規状態の書き込み承認を分ける。
Auto既定化の前に、既存Write-Safety Gateを満たさなければならない。

Work Scope、Focus、資料リンク、Chatを開く操作はいずれも書き込み同意ではない。
追加読み取りも、対象Project・Narrative Scope・開示・送信先・budget・grant等の
既存契約の範囲内で行う。Work基本情報、引用、追加tool結果にもそれぞれの材料開示判定を適用する。

明示的OFFまたは実効経路の能力不足では、注入済み材料の範囲で相談・比較・計画検討を提供する。
作品横断の実施済み確認を装わない。OFFを迂回する隠れた探索Agentは起動しない。
別途許可された決定的な検索・材料選択の有無は既存設定と実効経路に従い、本ADRでは強制しない。

UIはAgent要求値だけでなく実効経路を示す。例えば、仕事名、基本情報、今回の資料、
追加探索の可否、実際に読んだ資料へたどれる表示を既存Context表示へ統合する。
材料不足なら、資料の追加・依頼の限定・探索の有効化が必要であることを示す。
それを機能完了や検査PASSへ読み替えない。

### 9. Session継続性はUI数と独立させる

表示を一つのChatパネルへ統合しても、Run／Interactionはその表示の寿命に従属しない。
表示していないSessionの結果・質問・未読・失敗は、当該Sessionへ保存・通知する。
Scene移動、Chat切り替え、Focus変更、Resolve終了をStopにしない。

ただし「navigationを越える継続」と「同時に複数root Runを実行できる」は別の能力である。
後者もADR 007の基盤で扱うが、これだけで既存Release Aの並列実行除外を解除しない。
並列数、同一対象への競合、budget、cancelの分離は後続の実装・受入れで確定する。
未対応時はqueue／明示拒否等を定め、UIから暗黙に並列化しない。
renderer loss後の透明resumeも、このADRでは追加しない。

## Invariants

1. Work状態、Focus、会話の帰属、表示先、Run状態は独立に判別できる。
2. Scene移動とFocus変更は、Work Sessionの帰属・保存先・依頼目的を変更しない。
3. 表示変更だけでWork／Taskを進行・完了・保留扱いにせず、Runをcancelしない。
4. SessionTaskの生成やFindingの存在だけでProject Taskを作らない。
5. 通常ChatとWorkScoped Chatは共通UIでも独立したSession／履歴を持つ。
6. 参照表示、参照先への移動、モデルへの送信は別の効果である。
7. 参照切れを別対象へ推測で修復せず、全履歴を再帰的に注入しない。
8. Resolve中は専用パネルを単体で閉じられないが、判断せずResolveから離れられる。
9. 既存Task Trayを複製する常駐Work詳細領域を、この要件のために新設しない。
10. Work Scope／Agent Autoは、開示条件や書き込み権限を拡張しない。
11. 注入済み情報だけの回答、部分調査、網羅的な確認を同一表示にしない。
12. 参照画像、ADR採択、UI prototypeの存在をruntime／consumerのactivation根拠にしない。

## Acceptance scenarios for follow-up implementation

以下は後続実装の受入れ条件であり、本PRのテストPASSを意味しない。

| ID | シナリオ | 必須結果 |
| --- | --- | --- |
| W01 | Work AへFocusし、Work Bを参照して開く | FocusはA、会話はB。送信・保存先もBであり、Aの目的を混入しない。 |
| W02 | Work AのRun中にFocusをBへ変える | AのWork状態・Task・Runは維持され、結果はAのSessionへ入る。 |
| W03 | Work会話中に別Sceneへ移動する | 会話と下書きを維持し、閲覧したSceneを勝手に注入しない。 |
| W04 | Scene追随表示からWork Sessionへ移り、元へ戻る | 各Sessionの履歴・下書き・閲覧位置が残り、旧Runのdeltaを混入しない。 |
| W05 | 通常ChatとWork間をmessage／Taskリンクで往復する | 正しいProject／対象／発言を開き、Focusを変えず、戻る経路を保つ。 |
| W06 | 削除・版不一致・開示不可の参照を開く／送る | 利用不能を示し、類似対象や非適格材料へfallbackしない。 |
| W07 | シーンの依頼にSessionTaskが生成される | 通常Chatで継続し、Project Taskや別常駐UIへ強制昇格しない。 |
| W08 | 明示承認でProject Workへ昇格する | 目的・制約・材料・原発言参照を保持し、元Sessionを付け替えない。 |
| W09 | Resolveへ入り、未判断で終了する | right stripe最上段に角丸なしの専用パネル・アイコン強調。重ね表示なし。退出だけでは処分しない。 |
| W10 | Resolve中のパネル単体close／プリセット切り替え | Resolveの入口と専用パネルを失わず、通常配置を壊さず復帰できる。 |
| W11 | Workを完了し、再起動する | 勝手に次のWorkを選ばず、選択復元からRunを開始しない。 |
| W12 | 同一Workで文章推敲と全編の知識状態調査を依頼する | 目的・問いに応じて材料が異なり、本文が必要な依頼をNIRだけで済ませない。 |
| W13 | Autoで追加取得し、本文変更を提案する | 読み取りと書き込み承認を分離し、取得した全材料にも既存開示境界を適用する。 |
| W14 | Agent OFF／ツール非対応／取得失敗／予算不足 | 隠れた探索をせず、実効能力と未確認範囲を示し、検査成功を装わない。 |
| W15 | 資料確認中に作者が目的・条件・本文を変更する | 捕捉した版を保ち、必要な再確認・stale判定へ進み、黙って基準を交換しない。 |
| W16 | 完了済み創作Workに後発Findingが出る | author-approved doneを黙って再openせず、別のattentionとして判断へ渡す。 |
| W17 | 非表示Sessionで質問待ち／完了／failureが発生する | 正しいSessionへ通知し、現在の会話・Focusを奪わない。 |
| W18 | 複数root Run／renderer再起動を要求する | 実装済み能力だけを提供し、並列や透明resumeの未対応を成功に読み替えない。 |

## Alternatives considered

| 案 | 判断と理由 |
| --- | --- |
| Work専用の第二の常駐Chat UI | 今回は不採用。会話の帰属を分離すればよく、同時常時表示は現在の必須要件ではない。 |
| Work詳細のモーダレス重ね表示／新規サイドドロワー | 不採用。作者の希望に反し、本文や既存Chatを覆うか、新しい領域を増やす。 |
| right stripe全体を通常／Workの別表示へ切り替える | 不採用。Task Trayとの重複を解消せず、Chat Scopeの問題以上のUI機構を導入する。 |
| Workを単なるProject-wide Chatとして一本化 | 不採用。具体的な仕事と会話の帰属を失う。 |
| Focused WorkへすべてのChatを自動追随させる | 不採用。作者の作業目印と会話対象を混同する。 |
| 全関連本文・NIR・参照Sessionの一括注入 | 不採用。目的別の必要性、予算、開示、版を無視する。 |
| WorkScopedはAgent必須でOFFを禁止 | 不採用。注入済み材料で成立する相談もある。安全なAutoを基本とし、OFFの限定動作を残す。 |
| 画像どおりのResolve Lensと画面外周フレーム | 不採用。right stripe専用ResolveパネルとStripeアイコンの強調へ変更する。 |

## Consequences / implementation boundary

共通Chatの再利用によって常駐UIの増殖を避けられる一方、Chat Scopeの追加だけでは完了しない。
会話帰属、view attachment、editor context、Task contract、追加取得、送信材料、実効経路を
それぞれ検証する必要がある。主題を表示しているだけで資料が十分だと主張してはならない。

本ADRはADR 007のGlobal Task ManagerをRelease Aの前提にしない方針と、既存Decision Gateを維持する。
WorkScoped Chat／Project Focusの実装時期は、上記Roadmapで別途判断する。
NIR統合、並列root Run、WorkPlanとのschema対応、複数window／deviceのFocus同期、
長い参照の表示方法、細かなショートカットや幅は後続設計事項とする。

## Reference prototype

[参照画像の一覧と、今回の採否・変更点](assets/012-work-chat/README.md) を参照。
画像はこの議論で提供された15枚の旧プロトタイプであり、実装済み機能、正しいstate遷移、
現行のセキュリティ／Scope／Freshness契約の証拠ではない。
特に旧Lensの重ね表示、外周フレーム、SAFE判定、古い結果のfallback説明はそのまま採用しない。
