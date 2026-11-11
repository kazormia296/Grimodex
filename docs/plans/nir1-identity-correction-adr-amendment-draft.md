# 作者の同定の訂正を規則として再利用する — ADR 改訂案（draft）

| 項目 | 内容 |
| ---- | ---- |
| draftRef | `nir1-identity-correction-proposal/1` |
| Status | `[precheck]` の draft。ユーザーの確認まで実装しない。既存の ADR・policy・コードは変えていない。**2026-11-11 にユーザーが「測ってから伺う」を選んだ**：先に、Codex の抽出を使ったデータで同定の review の負荷を測る方法を調べて示し、★8 つはその結果と一緒に伺う（評価データは Codex 0 件で、負荷は未測定）。同日に確かめた点：`CodexEntityResolutionPicker` は同定の review の画面で使われる（`src/features/codex/CodexEntityProposalReview.tsx:288`）／`candidateKey` は前後の空白の除去・NFC・英大文字の小文字化だけで、全角と半角・かなの揺れは吸収しない（`src/features/codex/codexCandidates.ts:25-30`）／観測は根拠の `sourceRef` を持つ（`src/features/narrative-extraction/evidence/types.ts:11-16`） |
| 基点 | worktree `unruffled-shamir-d6147f`（master `2caf67a6`）。行番号はこの基点のもの |
| 由来 | roadmap の M3「Epic P0-A」ERM-0（`docs/plans/narrative-semantic-core-roadmap.md:578-590`）。ユーザーの選択（2026-11-10）は「規則の ADR も起こす」 |
| 前提 | 作者に長い文書を読ませない。Codex の名前・設定は抽出の文脈として provider に送ってよい（2026-11-05） |

用語：**表記**（surface）は本文に出る呼び方（例：「先生」）。**Entry** は Codex の項目（人物など）。
**規則**は作者が宣言した「この表記はこの Entry」という Source（一次入力）。**Rejection** は review で提案を採らなかった記録。
**Source**＝現在の版を決定的に解決できる一次入力（ADR 005 :143-158）。**immutable**＝書いた版を変えず、新しい版を足す。
**`human-direct`**＝作者の UI から typed writer で直接書く経路（ADR 006）。**OCC**＝版の突き合わせで後勝ちの上書きを防ぐ仕組み。
**Change Feed**＝書込みの記録の流れ。**Freshness／stale**＝入力が変わって提案が古くなったという状態。**fail closed**＝判定できない時は当てずに止める。
**Order Oracle**＝語り順・作中時間の前後を判定する部品（ADR 009、未実装）。**ERM-2**＝merge／split の提案の段。**P0-B**＝Structure Health（構造の不整合の一覧）の Epic。

## 一枚目：推奨と残る問い

推奨（要点）
- 新しい ADR 013「Identity Correction Rule Contract」として起こし、ADR 005 には参照の 1 行だけ足す（§1）。
- 最初は `must-link-surface`（表記 → Entry）の 1 種だけ。scope は「作品全体」か「この場面だけ」の 2 択（§2）。
- 規則は作者の宣言の Source として新しい表に immutable な版で保存し、`human-direct` の経路だけで書く（§3）。
- 規則は model の出力より先に決定的に適用し、矛盾したら勝者を選ばず「未解決」に戻して見せる（§4）。
- 規則は AI に送らない。model の出力の後で native／決定的な層が当てる（§5、★3）。
- 入口は、作者が review で人物を選んだ直後の 1 行の問い「次からも『先生』→田中にする？［この場面だけ］［全体］［しない］」（§8）。

★ ユーザーの確認が要る点（選択肢と推奨）
- ★1 形式：A＝新しい ADR 013（推奨）／B＝ADR 005 の Amendment。
- ★2 保存範囲の拡大：A＝新しい表 `narrative_identity_correction_rules`（版と適用の記録を持つ。推奨）／B＝`codex_entries` に JSON 列を足す（scope・履歴・Freshness に乗せにくい）／C＝保存しない（別名の解決だけ）。
- ★3 送信範囲：A＝規則を AI に送らない（推奨）／B＝規則の表記と Entry 名だけを抽出の文脈に足す（Codex の名前は了承済みだが、規則・理由・場面の対応は新しい送信）。
- ★4 最初の組：A＝`must-link-surface` だけ（推奨）／B＝`cannot-link-entries` も同時（merge の提案〔ERM-2〕が無い今は適用先が乏しい）。
- ★5 場面の規則と全体の規則の関係：A＝場面の規則を全体の規則の「例外」として優先する（作成時に「全体の規則の例外になります」と表示。推奨）／B＝両方あれば競合として止める。
- ★6 作成の経路：A＝作者の UI（`human-direct`）だけ（推奨）／B＝chat の tool（`interactive-agent-command`）からも作れる。
- ★7 §10 の脅威モデルの 4 点の確認。確認まで draft のまま。
- ★8 規則を作った時の review 待ちの提案：A＝同じ表記の未 review の提案を解き直して件数を見せる（推奨）／B＝次の抽出から（§5）。

## 1. 新しい ADR か、ADR 005 の Amendment か

推奨は新しい ADR 013（★1）。理由は 3 つ。
- ADR 005 は Scope・Route・Dependency を別 ADR に正本として委ねる前例を持つ（`docs/adr/005-narrative-semantic-core-boundary.md:9-12`。006・009・010 を指す）。規則も同じ形にできる。
- 規則は 005 の Deferred decisions（:1018-1033）のどれにも当たらない新しい Source の種類・writer・優先順位で、005 の本文（1,234 行）に足すと境界の本文と混ざる。
- `docs/adr/README.md:9-20` の表は 012 まで。番号の付け方は README に規則が無く、表の連番に従って 013 とする（推測）。

ADR 005 側の変更は、Status の正本の一覧に「同定の訂正規則は ADR 013」を 1 行足すだけにする。Iron Law（:848-873）は変えない。規則は Iron Law 1「本文と明示的な作者宣言を一次 Source とする」（:850）の「作者宣言」に当たる。

## 2. 規則の種類と型

roadmap の 5 種（:584-588）のうち、v1 は `must-link-surface` だけにする（★4）。
- `preferred-binding`（複数の候補から 1 つを優先）は、曖昧な表記に `must-link-surface` を置けば同じ結果になるので、型を増やさない。
- `preferred-canonical-name` は Codex の名前と別名の編集（既存の作者の編集）で足りる。
- `cannot-link-entries`・`suppressed-merge-candidate` は merge の提案（ERM-2、roadmap :599-619）が適用先になる。現行の抽出が既存の 2 Entry の同一視を提案するかは未確認。

型の案（v1）。
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
roadmap :590 の「author・time・scope・provenance・supersession・reason」をすべて持つ。

**場面ごとに変わる規則**（同じ「先生」が場面で別人）は `scope.scene = exact` の規則を場面ごとに置いて表す。
- ADR 009 の Scope V2 の scene 軸（`docs/adr/009-narrative-scope-relation-contract.md:146-187`）から `any` と `exact` だけを借りる閉じた部分集合にする。`unresolved` と他の軸は持たない。
- ADR 009 §1（:115-132）は「Scope は出所でなく適用範囲」とし、意味が Scene 局所のときだけ `scene = exact` を許す。「この場面の『先生』は佐藤」は意味が場面局所なので、この条件に合う。
- ADR 009 §4（:214-282）の軸の profile は Assertion 種別ごとなので、規則用の閉じた profile（scene は any／exact、他の軸は any 固定）は ADR 013 が定義する。
- 場面は言及ごとに、その言及の根拠の文書から取る。Codex の照合の入力は cluster の表記の束（`runEntityResolutionTask.ts:48-50`、`:190`）で、cluster は複数の言及の observation を持つ（`src/features/narrative-extraction/ir/inferences/codexEntityHypothesis.ts:79-86`）。1 つの cluster や提案の中で言及ごとの結果が割れたら、その表記は未解決に戻して見せる。場面の ref が消えた規則は当てない（fail closed）。cluster を作る段で場面の規則により束を分けるかは後の設計（observation が場面の ref を持つかは未確認）。
- ADR 009 の比較器・Order Oracle は `declared` で本番の入口が無い（:11-15、:27-29）。v1 は「言及の場面 = ref か、規則が any か」の一致だけを使い、009 の比較器に依存しない。
- 「第 3 章以降は別人」のような範囲は `readingOrder` の interval が要り、Order Oracle を待つ。v1 は場面ごとの規則を UI でまとめて作ることで代える（限界）。
- 同じ場面に同じ表記で 2 人がいる場合（例：2 人の「先生」）は表せない。その場面の表記は未解決のまま review に残す（限界）。

## 3. 保存先と authority

- 規則は roadmap :576 の「明示的で versioned な author declaration Source」として、新しい表に immutable な版で保存する（★2）。
  `narrative-ir-contract.json:43,50` の `modality-author-declaration`／`author-declaration` は IR の Assertion の語彙で、`assertionKinds` は `scene-event@1` だけ（:35）。規則は IR の Assertion ではないので、この語彙は流用しない。
- authority は新設しない。`policies/narrative/semantic-core-authorities.json:17-22` の concern `domain-state`（canonical authority は「typed native writer」、`typed-writer-only`）に乗せる。Feature-private な authority は作らない（ADR 005 :1032-1033）。
- 書込みの経路は ADR 006 の `human-direct`（`docs/adr/006-narrative-mutation-authority-routes.md:53-65`、`mutation-authority-routes.json:24` の allowedCallers は `human-ui`・`manual-wrapper`・`typed-domain-api`）。typed writer・actor context・OCC・canonical Change Event・Change Feed を通る。
  規則の writer は route の allowedCallers をさらに `human-ui` だけに絞る（writer ごとの allowedCallers は `change-feed-writers.json:1829` などに既に例がある）。`manual-wrapper`・`typed-domain-api` は v1 では許さない（中身は未確認のため）。
  `attention-typed-writer` は Change Feed を出さない（006:139-143）ので Freshness に乗らず、使わない。
- Freshness：規則の版の変更は Change Feed に出て、role `author-correction`（`narrative-dependency-role-registry.json:76-77`、ADR 010 :139）の Dependency を通じて、その規則を使った提案の版を stale にする（規則 `author-correction-input-changed`、registry :217-224、consumerKind `proposal-revision`、`resolve-only`）。
  - 適用済みの Domain Data は書き換えない。Dependency の伝播は freshness だけ（ADR 005 Iron Law 9、:860-861、roadmap :619）。
  - この role は語彙として `src/features/narrative-semantic-core/contracts/dependencyRole.ts:16` と `src-tauri/crates/grimodex-core/src/narrative_dependency.rs` にあるが、policies の中でこの role を宣言する producer は無い（role registry と ADR 010 だけ）。v1 で `narrative-dependency-producer-registry.json` に抽出の producer の宣言を足す。索引・chat の consumer に同じ Freshness を足すなら、それは新しい契約になり ★2 と一緒に確認する。
- 新しい writer は `change-feed-writers.json` と保護 writer の一覧に登録する。schema の版の番号は未確認（定数を見つけられなかった）。

## 4. 優先順位と競合

適用の順序（Codex の抽出の照合 `matchExistingEntity`）。
1. 作者の規則（scope が言及の場面に当たる active な `must-link-surface`）。
2. model が返す `explicitIdentityRefs`（今はこれが最初に見られ、1 件なら自動で解決される。`src/features/codex/extraction/existingEntityMatcher.ts:144-157`、供給元は `src/application/narrative-extraction/aiTasks/runEntityResolutionTask.ts:185-191`）。
3. exact-name → exact-alias（:225-247）。敬称の除去・prefix・substring は今も自動で解決せず review の候補だけ（:249-259）。この扱いは変えない。

規則と model が食い違うときは規則を採り、model の候補は「AI は別の人物を示した」として review に並べる（model の確信度は authority にならない。Iron Law 13、:867）。

競合（fail closed）。
- 同じ表記・同じ scope の active な規則が別の Entry を指す → どちらも当てず、表記を未解決に戻し、review カードに「規則どうしが食い違う」と出す。Structure Health（roadmap の P0-B）が入ったらそこにも出す。
- 規則の Entry が消えた・別 project → 規則を当てず、同じく表示する。
- 場面の規則と全体の規則が別の Entry を指す → ★5。推奨 A では場面の規則を例外として採る。これは作成時に作者が「例外」と明示した宣言で、勝者の自動選択ではない、と ADR に書く。

Rejection と規則の違い（ADR 005 :581-604、Iron Law 7）。
- Rejection は「この版・この source basis・この scope で採らなかった」だけで、次の抽出を縛らない。
- 規則は以後の抽出を縛る。Rejection から規則を自動で作らない。作るのは作者の明示の操作だけ。

## 5. 適用の箇所と順序

| 順 | 箇所 | v1 | 根拠 |
| -- | ---- | -- | ---- |
| 1 | Codex の Entity の抽出の照合 | 入れる | `existingEntityMatcher.ts:140`、review は `src/features/codex/CodexEntityResolutionPicker.tsx` |
| 2 | Chronicle の提案の参加者の表記の解決（表示） | 入れる | 表記は `unresolvedMetadata.participantSurfaces` に未解決で残る（`src/features/chronicle/extraction/proposalPlanner.ts:185-189`）。表示は文字列の連結だけ（`src/features/chronicle/ChronicleEvidencePane.tsx:87-88`） |
| 3 | 言及の索引・エディタの強調 | 後 | `src/features/codex/codexMatcher.ts`・`rustMatcher.ts` は作品全体の別名で照合し、場面の scope を持たない |
| 4 | 検索・Related Scenes・chat の文脈 | 後 | 開示の方針（ADR 005 :1196-1197）を通す設計が先 |

- review 待ちの提案：Dependency の辺は規則を使った提案にしか無く、Codex の解決は hypothesis の作成時に決まる（`runEntityResolutionTask.ts:188-194`）。新しい規則は既存の提案を stale にしない。★8 で扱いを選ぶ：A＝規則を作った時に、同じ表記の未 review の提案を決定的に解き直し、「ほかに 4 件に当てました［見る］」と件数を見せる（推奨。review の負荷を下げる目的に合う）／B＝次の抽出からだけ当てる。A でも適用済みの Domain Data は触らない。
- Chronicle では元の `participantSurfaces` を書き換えず、解決の結果を別の欄（どの規則の版か付き）として重ねる。
- 決定的な Core が同一性を推測しない原則（ADR 005 :409-410、:1191-1193）との区別：規則の適用は、作者が宣言した表記を正規化後の完全一致で引くだけで、推測ではない。敬称の除去や部分一致では規則を当てない。対象は Codex Entry の id で、Assertion の `assertionId` の扱い（:392-410、nullable のまま）は動かさない。
- AI への送信：推奨（★3 A）では規則を送らず、model の出力の後に当てる。roadmap :594「model の確信度より先に当てる」は判定の順序の話で、送らなくても満たせる。

## 6. 別名で足りる範囲と、規則が要る範囲

別名（`codex_entries.aliases`、除外は `excluded_aliases`。作者の UI は `src/features/codex/components/AliasesField.tsx`・`AliasesChip.tsx`・`ExcludedAliasesField.tsx`）で足りるのは、次の 3 つがそろうとき。
- 作品全体で 1 人だけを指す。
- 正の対応だけ（「この表記はこの人」）。
- 由来・履歴・場面の区別が要らない。

規則が要るのは次のとき。
- 場面で指す人が変わる（「先生」）。
- exact-alias が複数の Entry に当たって曖昧になる（`existingEntityMatcher.ts:240-246` で ambiguous に止まる）。
- 表記を Codex の別名にしたくない（別名にするとエディタの強調・検索で作品全体に効く）。
- 否定（「この表記はこの人ではない」）。抽出側の照合は `excluded_aliases` を見ていない（`existingEntityMatcher.ts` に excluded の参照は 0 件。言及側の `rustMatcher.ts:66-69` は見る）。

選ばれなかった「別名での解決」（Chronicle の表記を別名で解決して表示し、1 クリックで別名に足す）は、上の「足りる範囲」の実装にそのまま当たる。新しい保存が要らないので、規則の確認と独立に先に入れてもよい（推測：規則 v1 の §5 の 2 は、この表示に規則の層を足す形になる）。

## 7. 履歴と取り消し（ERM-3）

- 規則は版を足すだけで、上書き・削除をしない。取り消しは `state = retired` の新しい版（roadmap :621-625）。作者の Undo は通常の Undo の系譜（`history-replay`、006:113-114）を使う。
- 提案の版は「どの規則の版を当てたか」の id を持つ。元の model の出力（hypothesis の payload と `explicitIdentityRefs`）は消さず、規則による解決は別の層として重ねる（roadmap :597）。
- 抽出をやり直したとき、どの規則が判断を変えたかを review カードに 1 行で出す（roadmap :625）。
- 規則の取り消しで、適用済みの Domain Data は戻さない。依存する提案が stale になり、作者が review し直す。

## 8. 作者の操作の最小形

- 主な入口：Codex の review で表記の人物を選んだ直後に、1 行の問い「次からも『先生』→田中にする？［この場面だけ］［全体］［しない］」。既定は［しない］で、何も押さなければ規則は作られない。
- Chronicle：未解決の参加者の表記を押すと人物の候補を出し、同じ 1 行の問いを出す（§5 の 2）。
- 一覧と取り消し：Codex の Entry の詳細に「この人物に結び付く表記」を並べ、各行に［この場面だけ／全体］と［やめる］を置く。
- 既存の `src/features/work-layer/CorrectionRulePreview.tsx` は UI のプレビューで、保存しないと画面に明記している（:63）。入口の候補だが、主な入口は review の場にする（推奨）。
- 作者に規則の型名（`must-link-surface` など）を見せない。

## 9. schema と送信の変更

- 新しい表（★2）：規則の版の表と、提案側の「当てた規則の版」の記録。保存範囲の拡大なので確認まで作らない。
- AI への送信（★3）：推奨は送らない。B を選ぶ場合も、`reason` の自由記述と場面の対応は送らない案を基本にする。

## 10. 脅威モデルの下書き（★7、確認まで draft）

1. 信頼する actor：作者（Human UI の `human-ui` caller）、native の typed writer。信頼しない actor：model の出力（`explicitIdentityRefs`・chat の tool 呼出しを含む）、本文の中の指示（prompt injection）、取り込みの package、renderer が申告する値、背景の保守・Reconciler、standalone MCP（v1 は MCP から規則を読み書きしない）。
2. 範囲内の攻撃：AI や本文の指示が規則を作る・変える／規則が黙って判断を変える／正体を隠した人物の規則が chat・検索でネタバレになる／消えた Entry を指す規則が当たる／矛盾する規則で勝手に勝者が選ばれる／取り込みで規則が持ち込まれる。範囲外：同じ端末で DB に直接触れられる者、作者が意図して誤った規則を作ること。
3. 必須の防御：書けるのは `human-direct` の `human-ui` caller だけ（★6 A）、native で Entry の存在・同じ project・scope の形を検証し直す、版は immutable、競合と dangling は fail closed、規則を使う箇所は開示の方針を通す、規則は AI に送らない（★3 A）、提案に当てた規則の版を記録する、取り込みは v1 で規則を運ばない。
4. 受入れへの影響：Gold・閾値・評価の規則は変えない。規則を使う評価は別の arm として登録する。規則の変更は既存の提案を stale にするので、review の件数が一時的に増えうる。

## 11. 受入れ条件（roadmap の Exit criteria との対応）

| Exit criteria（roadmap :629-632） | v1 |
| --- | --- |
| 訂正した結び付けが、次の抽出で作者に聞かずに再利用される | 満たす（Codex の抽出、Chronicle の表示）。場面の規則は別の場面に当たらないことも試験する |
| cannot-link が同じ誤った merge の提案を防ぐ | 後回し（★4 B か ERM-2） |
| 矛盾する規則が fail closed し、Structure Health に出る | fail closed と review カードの表示は満たす。Structure Health は P0-B 待ち |
| Merge／Split の影響の preview と取り消し | 後回し（ERM-2） |

v1 の追加の条件：規則の版の変更で依存する提案が stale になる／model の出力が規則と別に残る／AI が規則を書けない（allowedCallers の否定の試験）／規則を AI の request に含めない（★3 A の場合）。

## 12. 未確認の点と限界

- 確かめた事実：§1〜§8 で file:line を付けた箇所は、この基点で grep・抜粋して確かめた。
- 未確認：現行 schema の版の番号／現行の抽出が既存の 2 Entry の同一視を提案するか／ADR 番号の付け方の明文の規則（README に無い）／observation が場面の ref を持つか／`codexMatcher`・`rustMatcher` が場面を持たないこと（構造からの推測）／別名がエディタの強調・検索に作品全体で効くこと（推測）／`candidateKey` の正規化の中身／`CodexEntityResolutionPicker.tsx` が同定の review の画面であること（名前からの推測）／`manual-wrapper`・`typed-domain-api` の中身。
- 未確認（前の報告のまま、repo の外）：評価データの数値（117 Scene の 2 作品で人物の表記 132 種／168 種など）。Codex が 0 件のため、規則で解ける割合は測れていない。
- 限界：範囲（第 3 章以降）は Order Oracle 待ち／同じ場面の同じ表記の 2 人は表せない／否定の規則は v1 に無い／言及の索引・検索・chat は v1 の外。
