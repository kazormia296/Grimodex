# ユーザーの回答（2026-11-19 深夜、AskUserQuestion）：AI への開示の既定、本文の宣言、Graph の範囲、関連シーンの未来の場面

## 経緯
- 秘密と開示のタイミングの棚卸し（`fusion-eval-data/design-notes/secret-reveal-protection-inventory-2026-11-19/report.md`）と、関連シーンの 3 経路の比較（`.../related-scenes-secret-exposure-2026-11-19/report.md`）の結果、次のことが分かった。
  - 関連シーンの R は、秘密を判定しない。
  - AI に送る経路の多くも、すでに開いている。
  - Graph の追加の場面にだけ、本文の宣言と veto が掛かっている。
- ユーザーの意見（逐語）：
  - 「画面はもちろん全て開示して問題ない認識です。」
  - 「関連シーンに未来のシーンは必要だと思いますが、そもそもこの関連シーンに対してそこまで比重を多くするべきなのかはもう少し慎重になるべきな気がします。」
  - 「AI経路の1は不具合で良いと思います。3,4,5辺りは許容していた気がします。」
  - 「そもそも論としてAIに対して情報をマスクするべきなのか？……アスペクト志向的な秘密の開示制御を行う必要がありそうでしょうか。」
  - 「個人的な意見としては、全部開示しちゃって良いんじゃないの？……そのような望ましくない挙動(勝手な情報の開示)は別のハーネスによって制御されるべきかもしれません。」
- Fable の設計相談（`.../secret-ai-masking-consult-2026-11-19/fable-consult.md`、J1〜J12）。

## 回答
1. **J1 AI への開示の既定：全部開示、作者の印は守る（推奨、Fable の (c)）**
   - 印の無いものは全部 AI に渡す（ラベル付き）。
   - 作者が明示した印（Codex の hidden、年表の secret）は渡さない。既存の印を黙って送らない。
   - 「これまで」の前後や Phase の位置の正しさは守る（マスクではなく正確さ）。
   - 勝手なネタバラシは、指示と応答の点検（警告）で抑える。
   - J2〜J6 の細部（印の強さ、既定値、振る舞いの層の測定、opt-in のマスクの用途）は、Fable の推奨を既定として起案し、確認の時に改めて示す。
2. **J8・J9 本文の宣言：廃止し、決めてから凍結（推奨）**
   - veto も外し、Graph の追加の場面を R と同じ扱いにする。
   - 確認済みの契約（K2/4、`graph-target-scene-body-disclosure`）の改訂として、新しい draftRef を起案して確認する。
   - それまで CP-4 の最後の凍結を始めない。事前登録（S2）・addendum・CB-4 の負例の試験の改版は、同じ凍結に入れる。
   - #968（OS ダイアログの廃止、DR-CB2-17）はその一部として扱う。
3. **Graph の範囲：制限なしでも使えるようにしたい**
   - 今は、外部送信の制限（restricted）を有効にした profile でだけ Graph が動く（`electron/native/grimodex-node/src/nir1_graph_product.rs:1302-1304`、`ProfileNotRestricted`）。
   - 統合者は、restricted が条件になった経緯と、外す案（新しい契約になる見込み）を調べて起案する。外部の AI provider への送信に関わる場合は、送信先の確認として改めて伺う。
4. **J10 関連シーンの未来の場面：R の別枠で、PUB-G の後（推奨）**
   - 過去の結果は変えない。

## 扱い
- PUB-G の範囲と順序が変わる。前提一覧（`pubg-prereq-inventory-2026-11-03.md`）は、起案の結果を待って付け直す。
- AI 経路の 1（「これまでのあらすじ」と「直前の場面」の前後）は、不具合として PR #976 で直している。

## 追記（2026-11-20 未明、AskUserQuestion）：草案の確定に要る 4 点
草案：`fusion-eval-data/design-notes/pubg-pivot-2026-11-19/`（graph-restricted-draft.md、declaration-abolition-draftref-draft.md、ai-disclosure-adr-draft.md、consistency-check.md）。
1. **Graph の restricted 条件：案 A で進める（推奨）**
   - Native の restricted の要求（`nir1_graph_product.rs:1302-1304`、:2809、`related_scenes/graph.rs:600-603`）を外し、Graph を R・IR と同じ扱いにする。
   - Graph の応答は画面にだけ使い、AI 送信・Packing・履歴・書き出しには載せない。新しい送信先はできない。
   - 確認済みの K3/2（`caller-profile-egress`）の Graph の行を改訂する、新しい draftRef を起案する。
   - 起案の前に、未確認の 2 点（`PublicationGuard.finish` が Graph の返却を覆うか、unrestricted での cache key の意味）を確かめる。
   - 最後の凍結で、unrestricted の Graph の parity を測り足す（閾値は変えない）。
2. **宣言の廃止の後に A1（Scene Scope の一致）を残すか：選ばず「Fableに聞いてみてください」**。統合者が Fable に相談し、結果を示して改めて伺う。
3. **#968：閉じる（推奨）**。2026-11-20 に merge せずに閉じた。DR-CB2-17 の分析は、廃止の draftRef に引き継ぐ。
4. **宣言のコードの撤去の時期：PUB-G の後（推奨）**
   - 凍結の前は、reader の判定（宣言の読込、束縛の照合、veto、quarantine）だけを外す。
   - 列（body_declaration_json など）は残して使わない。migration はしない。
